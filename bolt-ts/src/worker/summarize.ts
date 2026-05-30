/**
 * Entry point for inline summarisation called by the message handler.
 *
 * Picks streaming or non-streaming flow based on config + intent, then
 * orchestrates the work end-to-end.
 */

import type { WebClient } from '@slack/web-api';
import { LlmClient } from '../ai/anthropic';
import type { AppConfig } from '../config';
import { sanitizeGeneratedSlackMrkdwn } from '../slack/sanitize';
import { getRecentMessages, getBotUserId } from '../slack/client';
import { applySafetyNetSections, buildSummarizePromptData } from './prompt_builder';
import { buildSummaryActionButtons } from './deliver';
import {
  CANONICAL_FAILURE_MESSAGE,
  buildStreamPrefix,
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
 */
export async function runSummarization(args: RunArgs): Promise<void> {
  const { config, client, request } = args;
  const llm =
    args.llm ??
    new LlmClient({
      apiKey: config.anthropicApiKey,
      model: config.anthropicModel,
      maxOutputTokens: config.anthropicMaxOutputTokens,
    });

  if (config.enableStreaming) {
    try {
      await streamSummaryToAssistantThread({
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
    } catch (err) {
      // streamSummaryToAssistantThread already surfaced a canonical failure to
      // the user (it owns replacing the partially-streamed message). Log and
      // swallow here so the caller's own catch doesn't post a *second*
      // identical failure notice into the thread.
      console.error('Streaming summarization failed after user was notified', {
        corr_id: request.correlationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  try {
    const messages = await getRecentMessages(client, request.channelId, request.messageCount);
    if (messages.length === 0) {
      await client.chat.postMessage({
        channel: request.originChannelId,
        thread_ts: request.threadTs,
        text: 'No messages found to summarize.',
      });
      return;
    }
    const botUserId = await getBotUserId(client);
    const userMessages = botUserId ? messages.filter((m) => m.user !== botUserId) : messages;
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
    const text = sanitizeGeneratedSlackMrkdwn(
      buildStreamPrefix(request.channelId, request.customStyle) + safetyNetted
    );
    const blocks = buildSummaryActionButtons({
      sourceChannelId: request.channelId,
      messageCount: request.messageCount,
      currentStyle: request.customStyle,
    });
    await client.chat.postMessage({
      channel: request.originChannelId,
      thread_ts: request.threadTs,
      text,
      blocks,
    });
  } catch (err) {
    console.error('Non-streaming summarization failed', {
      corr_id: request.correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await client.chat.postMessage({
        channel: request.originChannelId,
        thread_ts: request.threadTs,
        text: CANONICAL_FAILURE_MESSAGE,
      });
    } catch (followup) {
      console.error('Failed to post canonical failure', followup);
    }
  }
}
