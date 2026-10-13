/**
 * Entry point for inline summarisation called by the message handler.
 *
 * Picks streaming or non-streaming flow based on config + intent, then
 * orchestrates the work end-to-end.
 */

import type { WebClient } from '@slack/web-api';
import type { KnownBlock, MessageMetadata } from '@slack/types';
import { LlmClient, PromptTooLargeError, TOO_LARGE_MESSAGE } from '../ai/anthropic';
import { buildFailureBlocks, buildRetryValue } from '../blocks';
import type { AppConfig } from '../config';
import { sanitizeGeneratedSlackMrkdwn, truncateForMarkdownBlock } from '../slack/sanitize';
import { BotNotInChannelError, getRecentMessages, getBotUserId } from '../slack/client';
import type { SummarizeOutcome, SummaryWindow } from '../types';
import { applySafetyNetSections, buildSummarizePromptData } from './prompt_builder';
import { buildSummaryActionButtons, buildSummaryMetadata } from './deliver';
import {
  CANONICAL_FAILURE_MESSAGE,
  buildBotNotInChannelMessage,
  buildEmptyChannelMessage,
  buildStreamPrefix,
  buildTooLargeBlocks,
  streamSummaryToAssistantThread,
} from './streaming';

export interface SummarizeRequest {
  correlationId: string;
  userId: string;
  /** Source channel to read history from. */
  channelId: string;
  /** Assistant DM channel where we'll reply. */
  originChannelId: string;
  /** Parent thread ts for replies. */
  threadTs: string;
  messageCount: number;
  customStyle: string | null;
  /** Omit only for a fresh history request. */
  window?: SummaryWindow;
  shorter?: boolean;
  /** Prior visible recap, excluded from delivery metadata and action payloads. */
  summaryToShorten?: string;
  /**
   * When set, the recap is posted with chat.postEphemeral for this user
   * and streaming is skipped. Streaming would publish the recap in the channel.
   */
  ephemeralUserId?: string;
}

interface RunArgs {
  config: AppConfig;
  client: WebClient;
  request: SummarizeRequest;
  llm?: LlmClient;
  fetchImpl?: typeof fetch;
}

/**
 * Summarise the requested channel and post the result back into the assistant
 * thread. Streams the response when `config.enableStreaming` is set; otherwise
 * makes a single Anthropic call and posts the result.
 *
 * Posts the user-facing message for every outcome itself — including a
 * retryable failure message — and never throws.
 */
export async function runSummarization(args: RunArgs): Promise<SummarizeOutcome> {
  const { config, client, request } = args;
  const llm =
    args.llm ??
    new LlmClient({
      apiKey: config.anthropicApiKey,
      model: config.anthropicModel,
      maxOutputTokens: config.anthropicMaxOutputTokens,
    });

  const postOutcome = async (
    text: string,
    blocks?: KnownBlock[],
    metadata?: MessageMetadata,
  ): Promise<void> => {
    if (request.ephemeralUserId) {
      await client.chat.postEphemeral({
        channel: request.originChannelId,
        user: request.ephemeralUserId,
        thread_ts: request.threadTs,
        text,
        ...(blocks ? { blocks } : {}),
      });
      return;
    }
    await client.chat.postMessage({
      channel: request.originChannelId,
      thread_ts: request.threadTs,
      text,
      ...(blocks ? { blocks } : {}),
      ...(metadata ? { metadata } : {}),
    });
  };

  // Ephemeral catch-up must not stream: chat.startStream publishes in the channel.
  if (config.enableStreaming && !request.ephemeralUserId) {
    return streamSummaryToAssistantThread({
      client,
      llm,
      botToken: config.slackBotToken,
      sourceChannelId: request.channelId,
      assistantChannelId: request.originChannelId,
      assistantThreadTs: request.threadTs,
      messageCount: request.messageCount,
      customStyle: request.customStyle,
      window: request.window,
      shorter: request.shorter,
      summaryToShorten: request.summaryToShorten,
      correlationId: request.correlationId,
      streamMaxChunkChars: config.streamMaxChunkChars,
      streamMinAppendIntervalMs: config.streamMinAppendIntervalMs,
      fetchImpl: args.fetchImpl,
    });
  }

  try {
    const messages = await getRecentMessages(client, request.channelId, request.messageCount, request.window);
    const botUserId = await getBotUserId(client);
    const userMessages = botUserId ? messages.filter((m) => m.user !== botUserId) : messages;
    if (userMessages.length === 0) {
      await postOutcome(buildEmptyChannelMessage(request.channelId, request.window));
      return 'empty';
    }
    const promptData = await buildSummarizePromptData({
      client,
      botToken: config.slackBotToken,
      channelId: request.channelId,
      messages: userMessages,
      customStyle: request.customStyle,
      shorter: request.shorter,
      summaryToShorten: request.summaryToShorten,
      fetchImpl: args.fetchImpl,
    });
    const summary = await llm.generateSummary(promptData.prompt);
    const safetyNetted = applySafetyNetSections(summary, promptData);
    const body = sanitizeGeneratedSlackMrkdwn(
      buildStreamPrefix(promptData.channelName, request.customStyle, promptData.coverage) + safetyNetted
    );
    const privateReply = request.ephemeralUserId !== undefined;
    // The body is standard Markdown — deliver it via a markdown block so it
    // renders, with `text` as the short notification fallback. The full body
    // also goes in `text` so the Share button (and notifications) can recover
    // it — Slack treats `text` purely as fallback when blocks are present.
    const delivery = {
      sourceChannelId: request.channelId,
      messageCount: request.messageCount,
      currentStyle: request.customStyle,
      coverage: promptData.coverage,
      sourceChannelName: promptData.channelName,
      window: request.window,
      shorter: request.shorter,
      sharePreview: summary,
      privateReply,
    };
    const blocks: KnownBlock[] = [
      { type: 'markdown', text: truncateForMarkdownBlock(body) },
      ...buildSummaryActionButtons(delivery),
    ];
    await postOutcome(body, blocks, buildSummaryMetadata(delivery));
    return 'delivered';
  } catch (err) {
    console.error('Non-streaming summarization failed', {
      corr_id: request.correlationId,
      error: err instanceof Error ? err.message : String(err),
    });

    if (err instanceof PromptTooLargeError) {
      try {
        await postOutcome(
          TOO_LARGE_MESSAGE,
          buildTooLargeBlocks(request.channelId, request.customStyle, { window: request.window, shorter: request.shorter, requiresOriginal: request.summaryToShorten !== undefined, privateReply: request.ephemeralUserId !== undefined }),
        );
      } catch (followup) {
        console.error('Failed to post too-large message', followup);
      }
      return 'too_large';
    }

    const failureText =
      err instanceof BotNotInChannelError
        ? buildBotNotInChannelMessage(request.channelId)
        : undefined;
    try {
      await postOutcome(
        CANONICAL_FAILURE_MESSAGE,
        buildFailureBlocks(
          buildRetryValue(request.channelId, request.messageCount, request.customStyle, { window: request.window, shorter: request.shorter, requiresOriginal: request.summaryToShorten !== undefined, privateReply: request.ephemeralUserId !== undefined }),
          failureText
        ),
      );
    } catch (followup) {
      console.error('Failed to post canonical failure', followup);
    }
    return 'failed';
  }
}
