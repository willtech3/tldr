/**
 * End-to-end streaming summarisation for assistant threads.
 *
 *  - Fetch messages, build prompt with images and link/receipt context.
 *  - Open an Anthropic Messages streaming request (Claude Opus 4.8 by default).
 *  - For each text delta, chunk and append to the Slack streaming message via
 *    `chat.appendStream`.
 *  - On completion, apply safety-net sections then call `chat.stopStream` with
 *    interactive action buttons.
 *  - On any failure, fall back to a canonical error message in-thread (and
 *    replace the streamed message body with the canonical text if streaming
 *    had already started).
 */

import type { WebClient } from '@slack/web-api';
import {
  LlmClient,
  PromptTooLargeError,
  type StreamingResponse,
  TOO_LARGE_MESSAGE,
  isPromptTooLargeError,
} from '../ai/anthropic';
import { buildFailureBlocks, buildRetryValue } from '../blocks';
import { sanitizeGeneratedSlackMrkdwn } from '../slack/sanitize';
import {
  BotNotInChannelError,
  appendStream,
  getBotUserId,
  getRecentMessages,
  startStream,
  stopStream,
} from '../slack/client';
import type { SummarizeOutcome, SummaryCoverage, SummaryWindow } from '../types';
import { summaryStyleLabel } from '../styles';
import { takeStreamChunk } from './chunks';
import { applySafetyNetSections, buildSummarizePromptData } from './prompt_builder';
import { buildCoverageText, buildSummaryActionButtons, buildSummaryMetadata } from './deliver';

export const CANONICAL_FAILURE_MESSAGE =
  "Sorry, I couldn't generate a summary at this time. Please try again later.";

/** Friendly reply when the source channel has no recent messages. */
export function buildEmptyChannelMessage(sourceChannelId: string, window?: SummaryWindow): string {
  if (window) {
    return `I couldn't find any remaining messages in this summary's original time window in <#${sourceChannelId}>. Refresh to summarize recent messages.`;
  }
  return `🪹 Nothing to summarize in <#${sourceChannelId}> yet — I couldn't find any recent messages. Switch to a busier channel and try again.`;
}

/** Guidance when the BOT (not the user) isn't in the source channel. */
export function buildBotNotInChannelMessage(sourceChannelId: string): string {
  return `🚪 I'm not in <#${sourceChannelId}> yet, so I can't read it. Run \`/invite @TLDR\` there, then tap *Try again*.`;
}

export interface StreamSummaryArgs {
  client: WebClient;
  llm: LlmClient;
  botToken: string;
  /** Channel to read history from. */
  sourceChannelId: string;
  /** Assistant DM channel to post into. */
  assistantChannelId: string;
  assistantThreadTs: string;
  messageCount: number;
  customStyle: string | null;
  /** Omit only for a fresh history request. */
  window?: SummaryWindow;
  shorter?: boolean;
  /** Prior visible recap, excluded from delivery metadata and action payloads. */
  summaryToShorten?: string;
  correlationId: string;
  /** Streaming knobs. */
  streamMaxChunkChars: number;
  streamMinAppendIntervalMs: number;
  /** Test-injectable sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Test-injectable fetch (for image downloads). */
  fetchImpl?: typeof fetch;
}

interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const defaultLogger: Logger = {
  info: (message, meta) => console.log(message, meta ?? ''),
  warn: (message, meta) => console.warn(message, meta ?? ''),
  error: (message, meta) => console.error(message, meta ?? ''),
};

/**
 * Run the end-to-end streaming summary, including safety-net cleanup. Posts
 * the user-facing message for every outcome itself (including failures, which
 * end in a retryable error message) and reports how the run ended.
 */
export async function streamSummaryToAssistantThread(
  args: StreamSummaryArgs,
  logger: Logger = defaultLogger
): Promise<SummarizeOutcome> {
  const sleep: (ms: number) => Promise<void> =
    args.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  let streamTs: string | null = null;

  try {
    const messages = await getRecentMessages(args.client, args.sourceChannelId, args.messageCount, args.window);

    // Filter out bot's own messages so it doesn't summarize itself — and
    // treat a bot-only channel as empty rather than summarizing nothing.
    const botUserId = await getBotUserId(args.client);
    const userMessages = botUserId
      ? messages.filter((m) => m.user !== botUserId)
      : messages;
    if (userMessages.length === 0) {
      await args.client.chat.postMessage({
        channel: args.assistantChannelId,
        thread_ts: args.assistantThreadTs,
        text: buildEmptyChannelMessage(args.sourceChannelId, args.window),
      });
      return 'empty';
    }

    const promptData = await buildSummarizePromptData({
      client: args.client,
      botToken: args.botToken,
      channelId: args.sourceChannelId,
      messages: userMessages,
      customStyle: args.customStyle,
      shorter: args.shorter,
      summaryToShorten: args.summaryToShorten,
      fetchImpl: args.fetchImpl,
    });

    const prefix = buildStreamPrefix(promptData.channelName, args.customStyle, promptData.coverage);
    const stream = await args.llm.generateSummaryStream(promptData.prompt);

    if (stream.kind === 'too_large') {
      await args.client.chat.postMessage({
        channel: args.assistantChannelId,
        thread_ts: args.assistantThreadTs,
        text: TOO_LARGE_MESSAGE,
        blocks: buildTooLargeBlocks(args.sourceChannelId, args.customStyle, { window: args.window, shorter: args.shorter, requiresOriginal: args.summaryToShorten !== undefined }),
      });
      return 'too_large';
    }

    // Start the stream with the header immediately — the user sees activity
    // while Anthropic is still thinking, instead of staring at dead air.
    streamTs = await startStream(args.client, {
      channel: args.assistantChannelId,
      threadTs: args.assistantThreadTs,
      markdownText: sanitizeGeneratedSlackMrkdwn(prefix),
    });

    const consumed = await consumeStream({
      ...args,
      sleep,
      promptData,
      stream,
      streamTs,
      logger,
    });
    // The user clicked Slack's stop button — accept it quietly.
    return consumed.stopped ? 'stopped' : 'delivered';
  } catch (err) {
    logger.error('Streaming summary failed', {
      corr_id: args.correlationId,
      error: err instanceof Error ? err.message : String(err),
    });

    if (err instanceof PromptTooLargeError) {
      await ensureCanonicalFailure({
        client: args.client,
        assistantChannelId: args.assistantChannelId,
        assistantThreadTs: args.assistantThreadTs,
        streamTs,
        correlationId: args.correlationId,
        retry: buildRetryValue(args.sourceChannelId, 50, args.customStyle, { window: args.window, shorter: args.shorter, requiresOriginal: args.summaryToShorten !== undefined }),
        failureText: buildTooLargeText(args.sourceChannelId),
        buttonLabel: '📉 Try last 50',
        logger,
      });
      return 'too_large';
    }

    const failureText =
      err instanceof BotNotInChannelError
        ? buildBotNotInChannelMessage(args.sourceChannelId)
        : undefined;
    await ensureCanonicalFailure({
      client: args.client,
      assistantChannelId: args.assistantChannelId,
      assistantThreadTs: args.assistantThreadTs,
      streamTs,
      correlationId: args.correlationId,
      retry: buildRetryValue(args.sourceChannelId, args.messageCount, args.customStyle, { window: args.window, shorter: args.shorter, requiresOriginal: args.summaryToShorten !== undefined }),
      failureText,
      logger,
    });
    return 'failed';
  }
}

function buildTooLargeText(sourceChannelId: string): string {
  return `📚 <#${sourceChannelId}> has too much going on to summarize in one go.\nWant the highlights of just the last 50?`;
}

/** "Conversation too long" blocks with a one-tap smaller retry. */
export function buildTooLargeBlocks(
  sourceChannelId: string,
  style: string | null,
  options: { window?: SummaryWindow; shorter?: boolean; requiresOriginal?: boolean } = {}
): ReturnType<typeof buildFailureBlocks> {
  return buildFailureBlocks(
    buildRetryValue(sourceChannelId, 50, style, options),
    buildTooLargeText(sourceChannelId),
    '📉 Try last 50'
  );
}

interface ConsumeStreamArgs extends StreamSummaryArgs {
  promptData: Awaited<ReturnType<typeof buildSummarizePromptData>>;
  stream: Extract<StreamingResponse, { kind: 'active' }>;
  /** Slack streaming message ts — already started with the header prefix. */
  streamTs: string;
  sleep: (ms: number) => Promise<void>;
  logger: Logger;
}

async function consumeStream(args: ConsumeStreamArgs): Promise<{ stopped: boolean }> {
  const streamTs: string = args.streamTs;
  let pending = '';
  let collected = '';
  let lastAppendAt: number | null = Date.now();
  let canAppend = true;

  const flushAll = async (ts: string): Promise<void> => {
    while (pending.length > 0) {
      if (lastAppendAt !== null) {
        const elapsed = Date.now() - lastAppendAt;
        const wait = args.streamMinAppendIntervalMs - elapsed;
        if (wait > 0) {
          await args.sleep(wait);
        }
      }
      const ok = await appendOneChunk({
        client: args.client,
        channel: args.assistantChannelId,
        ts,
        pending,
        maxChunkChars: args.streamMaxChunkChars,
        correlationId: args.correlationId,
        logger: args.logger,
      });
      if (!ok) {
        canAppend = false;
        break;
      }
      pending = ok.rest;
      lastAppendAt = Date.now();
    }
  };

  try {
    while (true) {
      const next = await args.stream.iterator.next();
      if (next.done) {
        break;
      }
      const event = next.value;
      if (event.kind === 'failed') {
        if (isPromptTooLargeError({ message: event.message })) {
          throw new PromptTooLargeError(event.message);
        }
        throw new Error(event.message);
      }
      if (event.kind === 'completed') {
        break;
      }
      if (event.kind !== 'text_delta' || event.delta.length === 0) {
        continue;
      }
      pending += event.delta;
      collected += event.delta;

      if (!canAppend || pending.length === 0 || lastAppendAt === null) {
        continue;
      }
      const elapsed = Date.now() - lastAppendAt;
      if (args.streamMinAppendIntervalMs === 0 || elapsed >= args.streamMinAppendIntervalMs) {
        const result = await appendOneChunk({
          client: args.client,
          channel: args.assistantChannelId,
          ts: streamTs,
          pending,
          maxChunkChars: args.streamMaxChunkChars,
          correlationId: args.correlationId,
          logger: args.logger,
        });
        if (!result) {
          canAppend = false;
        } else {
          pending = result.rest;
          lastAppendAt = Date.now();
        }
      }
    }
  } finally {
    // Best-effort: stop receiving more bytes from Anthropic.
    if (typeof args.stream.cancel === 'function') {
      void args.stream.cancel();
    }
  }

  if (collected.length === 0) {
    throw new Error('Anthropic stream completed without any output');
  }

  if (canAppend) {
    await flushAll(streamTs);
  }

  // Apply safety-net sections post-stream; append the diff.
  const beforeLen = collected.length;
  const finalised = applySafetyNetSections(collected, args.promptData);
  if (finalised.length > beforeLen) {
    pending += finalised.slice(beforeLen);
    if (canAppend) {
      await flushAll(streamTs);
    }
  }

  if (canAppend) {
    await finalizeStreamSuccess({
      client: args.client,
      channel: args.assistantChannelId,
      streamTs,
      sourceChannelId: args.sourceChannelId,
      messageCount: args.messageCount,
      customStyle: args.customStyle,
      coverage: args.promptData.coverage,
      sourceChannelName: args.promptData.channelName,
      window: args.window,
      shorter: args.shorter,
    });
  }

  return { stopped: !canAppend };
}

interface AppendOneChunkArgs {
  client: WebClient;
  channel: string;
  ts: string;
  pending: string;
  maxChunkChars: number;
  correlationId: string;
  logger: Logger;
}

/**
 * Take one chunk off `pending` and post it. Returns the updated buffer state,
 * or `null` when the Slack message has left streaming state.
 */
async function appendOneChunk(
  args: AppendOneChunkArgs
): Promise<{ rest: string } | null> {
  const taken = takeStreamChunk(args.pending, args.maxChunkChars);
  if (!taken) {
    return { rest: '' };
  }
  const sanitised = sanitizeGeneratedSlackMrkdwn(taken.chunk);
  const result = await appendStream(args.client, {
    channel: args.channel,
    ts: args.ts,
    markdownText: sanitised,
  });
  if (result.kind === 'closed') {
    args.logger.warn('Slack streaming message left streaming state during append', {
      corr_id: args.correlationId,
      dropped_chars: [...taken.chunk].length,
    });
    return null;
  }
  return { rest: taken.rest };
}

async function finalizeStreamSuccess(args: {
  client: WebClient;
  channel: string;
  streamTs: string;
  sourceChannelId: string;
  messageCount: number;
  customStyle: string | null;
  coverage: SummaryCoverage;
  sourceChannelName: string;
  window?: SummaryWindow;
  shorter?: boolean;
}): Promise<void> {
  const delivery = {
    sourceChannelId: args.sourceChannelId,
    messageCount: args.messageCount,
    currentStyle: args.customStyle,
    coverage: args.coverage,
    sourceChannelName: args.sourceChannelName,
    window: args.window,
    shorter: args.shorter,
  };
  const blocks = buildSummaryActionButtons(delivery);
  await stopStream(args.client, {
    channel: args.channel,
    ts: args.streamTs,
    blocks,
    metadata: buildSummaryMetadata(delivery),
  });
}

interface EnsureCanonicalFailureArgs {
  client: WebClient;
  assistantChannelId: string;
  assistantThreadTs: string;
  streamTs: string | null;
  correlationId: string;
  /** Original request, embedded in the retry button (pre-bounded via buildRetryValue). */
  retry: ReturnType<typeof buildRetryValue>;
  /** Override the default apology (e.g. bot-not-in-channel guidance). */
  failureText?: string;
  /** Override the retry button label. */
  buttonLabel?: string;
  logger: Logger;
}

async function ensureCanonicalFailure(args: EnsureCanonicalFailureArgs): Promise<void> {
  const failureBlocks = buildFailureBlocks(args.retry, args.failureText, args.buttonLabel);

  if (!args.streamTs) {
    try {
      await args.client.chat.postMessage({
        channel: args.assistantChannelId,
        thread_ts: args.assistantThreadTs,
        text: CANONICAL_FAILURE_MESSAGE,
        blocks: failureBlocks,
      });
    } catch (err) {
      args.logger.error('Failed to post canonical failure message', {
        corr_id: args.correlationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Streaming started — stop it, then overwrite the body with the error message.
  try {
    await stopStream(args.client, { channel: args.assistantChannelId, ts: args.streamTs });
  } catch (err) {
    args.logger.warn('Failed to stop stream during cleanup', {
      corr_id: args.correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await args.client.chat.update({
      channel: args.assistantChannelId,
      ts: args.streamTs,
      text: CANONICAL_FAILURE_MESSAGE,
      blocks: failureBlocks,
    });
    return;
  } catch (err) {
    args.logger.warn('Failed to overwrite streamed message during cleanup', {
      corr_id: args.correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await args.client.chat.delete({ channel: args.assistantChannelId, ts: args.streamTs });
  } catch (err) {
    args.logger.warn('Failed to delete streamed message during cleanup', {
      corr_id: args.correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await args.client.chat.postMessage({
      channel: args.assistantChannelId,
      thread_ts: args.assistantThreadTs,
      text: CANONICAL_FAILURE_MESSAGE,
      blocks: failureBlocks,
    });
  } catch (err) {
    args.logger.error('Failed to post fallback canonical failure message', {
      corr_id: args.correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build the streaming prefix shown above the LLM-streamed body.
 *
 * Written in standard Markdown — the chat.*Stream `markdown_text` field is a
 * Markdown renderer, so mrkdwn tokens like `<#C123>` would render literally.
 * Takes the human-readable channel name (falls back to whatever is passed,
 * e.g. a channel ID when the name lookup failed).
 */
export function buildStreamPrefix(
  channelName: string,
  customStyle: string | null,
  coverage?: SummaryCoverage
): string {
  const style = summaryStyleLabel(customStyle);
  const stylePrefix = style ? `_Style: ${style}_\n\n` : '';
  const label = /^[A-Z][A-Z0-9]{8,}$/.test(channelName) ? channelName : `#${channelName}`;
  const scope = coverage ? `${buildCoverageText(coverage)}\n\n` : '';
  return `${stylePrefix}**Summary of ${label}**\n\n${scope}`;
}
