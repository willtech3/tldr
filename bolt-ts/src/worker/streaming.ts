/**
 * End-to-end streaming summarisation for assistant threads.
 *
 *  - Fetch messages, build prompt with images and link/receipt context.
 *  - Open an Anthropic Messages streaming request (Claude Sonnet 4.6).
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
  type StreamingResponse,
  TOO_LARGE_MESSAGE,
} from '../ai/anthropic';
import { sanitizeGeneratedSlackMrkdwn } from '../slack/sanitize';
import {
  STREAM_MARKDOWN_TEXT_LIMIT,
  appendStream,
  getBotUserId,
  getRecentMessages,
  startStream,
  stopStream,
} from '../slack/client';
import { takeStreamChunk } from './chunks';
import { applySafetyNetSections, buildSummarizePromptData } from './prompt_builder';
import { buildSummaryActionButtons } from './deliver';

export const CANONICAL_FAILURE_MESSAGE =
  "Sorry, I couldn't generate a summary at this time. Please try again later.";

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
 * Run the end-to-end streaming summary, including safety-net cleanup. Returns
 * normally on success; throws if cleanup fails fatally.
 */
export async function streamSummaryToAssistantThread(
  args: StreamSummaryArgs,
  logger: Logger = defaultLogger
): Promise<void> {
  const sleep: (ms: number) => Promise<void> =
    args.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  let streamTs: string | null = null;

  try {
    const messages = await getRecentMessages(args.client, args.sourceChannelId, args.messageCount);
    if (messages.length === 0) {
      await args.client.chat.postMessage({
        channel: args.assistantChannelId,
        thread_ts: args.assistantThreadTs,
        text: 'No messages found to summarize.',
      });
      return;
    }

    // Filter out bot's own messages so it doesn't summarize itself.
    const botUserId = await getBotUserId(args.client);
    const userMessages = botUserId
      ? messages.filter((m) => m.user !== botUserId)
      : messages;

    const promptData = await buildSummarizePromptData({
      client: args.client,
      botToken: args.botToken,
      channelId: args.sourceChannelId,
      messages: userMessages,
      customStyle: args.customStyle,
      fetchImpl: args.fetchImpl,
    });

    const prefix = buildStreamPrefix(args.sourceChannelId, args.customStyle);
    const stream = await args.llm.generateSummaryStream(promptData.prompt);

    if (stream.kind === 'too_large') {
      const message = sanitizeGeneratedSlackMrkdwn(
        prefix + applySafetyNetSections(TOO_LARGE_MESSAGE, promptData)
      );
      await args.client.chat.postMessage({
        channel: args.assistantChannelId,
        thread_ts: args.assistantThreadTs,
        text: message,
      });
      return;
    }

    streamTs = await consumeStream({
      ...args,
      sleep,
      prefix,
      promptData,
      stream,
      streamTs: null,
      logger,
      // Surface the streamed message ts to this scope the instant it exists, so
      // a mid-stream failure can replace the partial message instead of
      // orphaning it and posting a duplicate error.
      onStreamStart: (ts: string): void => {
        streamTs = ts;
      },
    });
  } catch (err) {
    logger.error('Streaming summary failed', {
      corr_id: args.correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
    await ensureCanonicalFailure({
      client: args.client,
      assistantChannelId: args.assistantChannelId,
      assistantThreadTs: args.assistantThreadTs,
      streamTs,
      correlationId: args.correlationId,
      logger,
    });
    throw err;
  }
}

interface ConsumeStreamArgs extends StreamSummaryArgs {
  prefix: string;
  promptData: { linksShared: string[]; receiptPermalinks: string[]; hasAnyImages: boolean };
  stream: Extract<StreamingResponse, { kind: 'active' }>;
  streamTs: string | null;
  sleep: (ms: number) => Promise<void>;
  logger: Logger;
  /** Called once with the streamed message ts as soon as the stream starts. */
  onStreamStart?: (ts: string) => void;
}

async function consumeStream(args: ConsumeStreamArgs): Promise<string> {
  let streamTs: string | null = args.streamTs;
  let pending = '';
  let collected = '';
  let lastAppendAt: number | null = null;
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

      if (streamTs === null) {
        const prefixChars = [...args.prefix].length;
        if (prefixChars >= STREAM_MARKDOWN_TEXT_LIMIT) {
          throw new Error('Streaming prefix exceeds Slack markdown limit');
        }
        const maxFirst = Math.min(
          STREAM_MARKDOWN_TEXT_LIMIT - prefixChars,
          args.streamMaxChunkChars
        );
        const taken = takeStreamChunk(pending, maxFirst);
        if (!taken) {
          continue;
        }
        const initialText = sanitizeGeneratedSlackMrkdwn(args.prefix + taken.chunk);
        streamTs = await startStream(args.client, {
          channel: args.assistantChannelId,
          threadTs: args.assistantThreadTs,
          markdownText: initialText,
        });
        args.onStreamStart?.(streamTs);
        pending = taken.rest;
        lastAppendAt = Date.now();
        continue;
      }

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

  if (streamTs === null) {
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
    });
  }

  return streamTs;
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
}): Promise<void> {
  const blocks = buildSummaryActionButtons({
    sourceChannelId: args.sourceChannelId,
    messageCount: args.messageCount,
    currentStyle: args.customStyle,
  });
  await stopStream(args.client, {
    channel: args.channel,
    ts: args.streamTs,
    blocks,
  });
}

interface EnsureCanonicalFailureArgs {
  client: WebClient;
  assistantChannelId: string;
  assistantThreadTs: string;
  streamTs: string | null;
  correlationId: string;
  logger: Logger;
}

async function ensureCanonicalFailure(args: EnsureCanonicalFailureArgs): Promise<void> {
  if (!args.streamTs) {
    try {
      await args.client.chat.postMessage({
        channel: args.assistantChannelId,
        thread_ts: args.assistantThreadTs,
        text: CANONICAL_FAILURE_MESSAGE,
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
      blocks: [],
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
    });
  } catch (err) {
    args.logger.error('Failed to post fallback canonical failure message', {
      corr_id: args.correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Build the streaming prefix shown above the LLM-streamed body. */
export function buildStreamPrefix(channelId: string, customStyle: string | null): string {
  let prefix = '';
  const stylePrefix = buildStylePrefix(customStyle);
  if (stylePrefix) {
    prefix += stylePrefix;
  }
  prefix += `*Summary from <#${channelId}>*\n\n`;
  return prefix;
}

function buildStylePrefix(customStyle: string | null): string | null {
  const trimmed = customStyle?.trim();
  if (!trimmed) {
    return null;
  }
  const chars = [...trimmed];
  const truncated = chars.length > 60 ? chars.slice(0, 57).join('') + '...' : trimmed;
  return `_Style: ${truncated}_\n\n`;
}
