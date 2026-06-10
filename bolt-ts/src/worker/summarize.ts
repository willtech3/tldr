/**
 * Entry point for inline summarisation called by the message handler.
 *
 * Picks streaming or non-streaming flow based on config + intent, then
 * orchestrates the work end-to-end.
 */

import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import { LlmClient, PromptTooLargeError, TOO_LARGE_MESSAGE } from '../ai/anthropic';
import { buildFailureBlocks, buildRetryValue } from '../blocks';
import type { AppConfig } from '../config';
import { sanitizeGeneratedSlackMrkdwn, truncateForMarkdownBlock } from '../slack/sanitize';
import { BotNotInChannelError, getRecentMessages, getBotUserId } from '../slack/client';
import type { SummarizeOutcome } from '../types';
import { applySafetyNetSections, buildSummarizePromptData } from './prompt_builder';
import { buildSummaryActionButtons } from './deliver';
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

  if (config.enableStreaming) {
    return streamSummaryToAssistantThread({
      client,
      llm,
      botToken: config.slackBotToken,
      sourceChannelId: request.channelId,
      assistantChannelId: request.originChannelId,
      assistantThreadTs: request.threadTs,
      messageCount: request.messageCount,
      customStyle: request.customStyle,
      correlationId: request.correlationId,
      streamMaxChunkChars: config.streamMaxChunkChars,
      streamMinAppendIntervalMs: config.streamMinAppendIntervalMs,
      fetchImpl: args.fetchImpl,
    });
  }

  try {
    const messages = await getRecentMessages(client, request.channelId, request.messageCount);
    const botUserId = await getBotUserId(client);
    const userMessages = botUserId ? messages.filter((m) => m.user !== botUserId) : messages;
    if (userMessages.length === 0) {
      await client.chat.postMessage({
        channel: request.originChannelId,
        thread_ts: request.threadTs,
        text: buildEmptyChannelMessage(request.channelId),
      });
      return 'empty';
    }
    const promptData = await buildSummarizePromptData({
      client,
      botToken: config.slackBotToken,
      channelId: request.channelId,
      messages: userMessages,
      customStyle: request.customStyle,
      fetchImpl: args.fetchImpl,
    });
    const summary = await llm.generateSummary(promptData.prompt);
    const safetyNetted = applySafetyNetSections(summary, promptData);
    const body = sanitizeGeneratedSlackMrkdwn(
      buildStreamPrefix(promptData.channelName, request.customStyle) + safetyNetted
    );
    // The body is standard Markdown — deliver it via a markdown block so it
    // renders, with `text` as the short notification fallback. The full body
    // also goes in `text` so the Share button (and notifications) can recover
    // it — Slack treats `text` purely as fallback when blocks are present.
    const blocks: KnownBlock[] = [
      { type: 'markdown', text: truncateForMarkdownBlock(body) },
      ...buildSummaryActionButtons({
        sourceChannelId: request.channelId,
        messageCount: request.messageCount,
        currentStyle: request.customStyle,
      }),
    ];
    await client.chat.postMessage({
      channel: request.originChannelId,
      thread_ts: request.threadTs,
      text: body,
      blocks,
    });
    return 'delivered';
  } catch (err) {
    console.error('Non-streaming summarization failed', {
      corr_id: request.correlationId,
      error: err instanceof Error ? err.message : String(err),
    });

    if (err instanceof PromptTooLargeError) {
      try {
        await client.chat.postMessage({
          channel: request.originChannelId,
          thread_ts: request.threadTs,
          text: TOO_LARGE_MESSAGE,
          blocks: buildTooLargeBlocks(request.channelId, request.customStyle),
        });
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
      await client.chat.postMessage({
        channel: request.originChannelId,
        thread_ts: request.threadTs,
        text: CANONICAL_FAILURE_MESSAGE,
        blocks: buildFailureBlocks(
          buildRetryValue(request.channelId, request.messageCount, request.customStyle),
          failureText
        ),
      });
    } catch (followup) {
      console.error('Failed to post canonical failure', followup);
    }
    return 'failed';
  }
}
