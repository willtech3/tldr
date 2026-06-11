/**
 * General-chat replies for assistant threads.
 *
 * When a message doesn't match any command intent, we answer it with the
 * model instead of a canned nudge: fetch the thread history for context,
 * build a chat prompt, and stream the reply into the thread via the same
 * chat.*Stream helpers the summarizer uses. Failures fall back to the old
 * "I didn't catch that" nudge so the user is never left on read.
 */

import type { WebClient } from '@slack/web-api';
import { LlmClient } from '../ai/anthropic';
import { buildChatPrompt, type ChatHistoryEntry } from '../ai/prompt';
import { buildUnknownIntentBlocks } from '../blocks';
import type { AppConfig } from '../config';
import { buildRateLimitMessage } from '../handlers/run_summary';
import { checkSummarizeRateLimit } from '../security';
import { sanitizeGeneratedSlackMrkdwn, truncateForMarkdownBlock } from '../slack/sanitize';
import {
  appendStream,
  getChannelName,
  getThreadMessages,
  startStream,
  stopStream,
} from '../slack/client';
import { takeStreamChunk } from './chunks';

/** Shown (with the nudge buttons) when the model call fails. */
export const CHAT_FAILURE_TEXT =
  "😅 I couldn't come up with a reply just now — try again, or ask for a summary.";

/** How many prior thread messages we hand the model as context. */
const HISTORY_LIMIT = 30;

/** Per-message cap so one giant paste doesn't crowd out the rest. */
const HISTORY_MESSAGE_MAX_CHARS = 1500;

export type ChatOutcome = 'delivered' | 'failed' | 'stopped' | 'rate_limited';

interface ChatLogger {
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

export interface GeneralChatArgs {
  client: WebClient;
  config: AppConfig;
  userId: string;
  /** Assistant DM channel + thread the reply goes to. */
  assistantChannelId: string;
  assistantThreadTs: string;
  /** The message text that fell through intent parsing. */
  userText: string;
  /** ts of the triggering message, excluded from the history context. */
  userMessageTs: string;
  /** Channel the user is viewing, if known (for conversational context). */
  viewingChannelId: string | null;
  logger: ChatLogger;
  /** Test injection points. */
  llm?: LlmClient;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Answer a general-chat message in the assistant thread. Posts a user-facing
 * message for every outcome (including failures) and never throws.
 */
export async function runGeneralChat(args: GeneralChatArgs): Promise<ChatOutcome> {
  const { client, config, logger } = args;

  // Chat shares the per-user budget with summaries so a chatty user can't
  // burn unlimited model calls.
  const rateLimit = checkSummarizeRateLimit(args.userId);
  if (!rateLimit.allowed) {
    await postPlain(args, buildRateLimitMessage(rateLimit.retryAfterMs));
    return 'rate_limited';
  }

  try {
    await client.assistant.threads.setStatus({
      channel_id: args.assistantChannelId,
      thread_ts: args.assistantThreadTs,
      status: '💬 Thinking...',
    });
  } catch (error) {
    logger.warn('Failed to set assistant thread status for chat:', error);
  }

  try {
    const history = await loadChatHistory(args);
    const viewingChannelName = args.viewingChannelId
      ? await getChannelName(client, args.viewingChannelId)
      : null;
    const prompt = buildChatPrompt({
      userMessage: args.userText,
      history,
      viewingChannelName,
    });

    const llm =
      args.llm ??
      new LlmClient({
        apiKey: config.anthropicApiKey,
        model: config.anthropicModel,
        maxOutputTokens: config.anthropicMaxOutputTokens,
      });

    if (!config.enableStreaming) {
      const reply = await llm.generateSummary(prompt);
      if (reply.trim().length === 0) {
        throw new Error('Empty chat reply from model');
      }
      const body = sanitizeGeneratedSlackMrkdwn(reply);
      await client.chat.postMessage({
        channel: args.assistantChannelId,
        thread_ts: args.assistantThreadTs,
        text: body,
        blocks: [{ type: 'markdown', text: truncateForMarkdownBlock(body) }],
      });
      return 'delivered';
    }

    return await streamChatReply(args, llm, prompt);
  } catch (error) {
    logger.error('General chat reply failed:', error);
    try {
      await client.chat.postMessage({
        channel: args.assistantChannelId,
        thread_ts: args.assistantThreadTs,
        text: CHAT_FAILURE_TEXT,
        blocks: buildUnknownIntentBlocks(args.viewingChannelId),
      });
    } catch (followup) {
      logger.error('Failed to post chat failure fallback:', followup);
    }
    return 'failed';
  }
}

/**
 * Fetch the assistant thread and shape it into chat history: oldest first,
 * sans the triggering message, each entry capped, empty/blocks-only messages
 * dropped. Bot messages (no `user`) are attributed to the assistant.
 */
async function loadChatHistory(args: GeneralChatArgs): Promise<ChatHistoryEntry[]> {
  try {
    const messages = await getThreadMessages(
      args.client,
      args.assistantChannelId,
      args.assistantThreadTs,
      HISTORY_LIMIT + 1
    );
    return messages
      .filter((m) => m.ts !== args.userMessageTs && m.text.trim().length > 0)
      .slice(-HISTORY_LIMIT)
      .map((m) => ({
        role: m.user ? ('user' as const) : ('assistant' as const),
        text: [...m.text].slice(0, HISTORY_MESSAGE_MAX_CHARS).join(''),
      }));
  } catch (error) {
    // Context is best-effort — answer without it rather than failing.
    args.logger.warn('Failed to load assistant thread history for chat:', error);
    return [];
  }
}

async function streamChatReply(
  args: GeneralChatArgs,
  llm: LlmClient,
  prompt: ReturnType<typeof buildChatPrompt>
): Promise<ChatOutcome> {
  const sleep: (ms: number) => Promise<void> =
    args.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  const stream = await llm.generateSummaryStream(prompt);
  if (stream.kind === 'too_large') {
    // A chat prompt should never exceed the context window; treat as failure.
    throw new Error('Chat prompt rejected as too large');
  }

  const streamTs = await startStream(args.client, {
    channel: args.assistantChannelId,
    threadTs: args.assistantThreadTs,
  });

  let pending = '';
  let collected = '';
  let lastAppendAt = Date.now();
  let canAppend = true;

  const appendChunk = async (): Promise<void> => {
    const taken = takeStreamChunk(pending, args.config.streamMaxChunkChars);
    if (!taken) {
      pending = '';
      return;
    }
    const result = await appendStream(args.client, {
      channel: args.assistantChannelId,
      ts: streamTs,
      markdownText: sanitizeGeneratedSlackMrkdwn(taken.chunk),
    });
    if (result.kind === 'closed') {
      // The user hit Slack's stop button — accept it quietly.
      canAppend = false;
      return;
    }
    pending = taken.rest;
    lastAppendAt = Date.now();
  };

  try {
    while (true) {
      const next = await stream.iterator.next();
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
      if (canAppend && Date.now() - lastAppendAt >= args.config.streamMinAppendIntervalMs) {
        await appendChunk();
      }
    }
  } catch (error) {
    // Stop the partial message before surfacing the failure fallback.
    await stopStream(args.client, {
      channel: args.assistantChannelId,
      ts: streamTs,
    }).catch(() => undefined);
    await args.client.chat
      .delete({ channel: args.assistantChannelId, ts: streamTs })
      .catch(() => undefined);
    throw error;
  } finally {
    void stream.cancel();
  }

  if (collected.length === 0) {
    await stopStream(args.client, {
      channel: args.assistantChannelId,
      ts: streamTs,
    }).catch(() => undefined);
    throw new Error('Anthropic chat stream completed without any output');
  }

  while (canAppend && pending.length > 0) {
    const wait = args.config.streamMinAppendIntervalMs - (Date.now() - lastAppendAt);
    if (wait > 0) {
      await sleep(wait);
    }
    await appendChunk();
  }

  if (canAppend) {
    await stopStream(args.client, { channel: args.assistantChannelId, ts: streamTs });
    return 'delivered';
  }
  return 'stopped';
}

async function postPlain(args: GeneralChatArgs, text: string): Promise<void> {
  await args.client.chat.postMessage({
    channel: args.assistantChannelId,
    thread_ts: args.assistantThreadTs,
    text,
  });
}
