/**
 * General-chat replies — the "standard chatbot" half of TLDR.
 *
 * Two surfaces share this engine:
 *  - assistant: messages in the assistant DM that don't match any command
 *    intent (help/style/summarize) fall through to chat.
 *  - channel: @-mentions of the bot in a channel get a chat reply in the
 *    message's thread.
 *
 * Both fetch the thread history for context, build a chat prompt, and stream
 * the reply via the same chat.*Stream helpers the summarizer uses. Chat is
 * text in / text out only — no tools, no actions. Failures fall back to a
 * friendly nudge so the user is never left on read.
 */

import type { WebClient } from '@slack/web-api';
import { LlmClient, type StreamingResponse } from '../ai/anthropic';
import { buildChatPrompt, type ChatHistoryEntry, type ChatSurface } from '../ai/prompt';
import { buildUnknownIntentBlocks } from '../blocks';
import type { AppConfig } from '../config';
import { buildRateLimitMessage } from '../handlers/run_summary';
import { checkSummarizeRateLimit } from '../security';
import { sanitizeGeneratedSlackMrkdwn, truncateForMarkdownBlock } from '../slack/sanitize';
import {
  appendStream,
  getBotUserId,
  getChannelName,
  getThreadMessages,
  getUserDisplayName,
  startStream,
  stopStream,
} from '../slack/client';
import { takeStreamChunk } from './chunks';

/** Shown (with the nudge buttons on the assistant surface) when the model call fails. */
export const CHAT_FAILURE_TEXT =
  "😅 I couldn't come up with a reply just now — try again, or ask for a summary.";

/** How many prior thread messages we hand the model as context. */
const HISTORY_LIMIT = 30;

/**
 * How many thread messages we fetch before keeping the newest
 * {@link HISTORY_LIMIT}. conversations.replies pages oldest-first, so one
 * page this size keeps context current for threads up to this long.
 */
const HISTORY_FETCH_LIMIT = 200;

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
  /** Which surface the reply goes to (drives status, fallbacks, attribution). */
  surface: ChatSurface;
  /** Conversation + thread the reply goes to. */
  channelId: string;
  threadTs: string;
  /** The message text being answered. */
  userText: string;
  /** ts of the triggering message, excluded from the history context. */
  userMessageTs: string;
  /** Assistant surface: channel the user is viewing, if known. */
  viewingChannelId?: string | null;
  /** Channel surface: workspace of the user — chat.startStream needs it outside DMs. */
  recipientTeamId?: string | null;
  logger: ChatLogger;
  /** Test injection points. */
  llm?: LlmClient;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Answer a general-chat message. Posts a user-facing message for every
 * outcome (including failures) and never throws.
 */
export async function runGeneralChat(args: GeneralChatArgs): Promise<ChatOutcome> {
  const { client, config, logger } = args;

  // Chat shares the per-user budget with summaries so a chatty user can't
  // burn unlimited model calls.
  const rateLimit = checkSummarizeRateLimit(args.userId);
  if (!rateLimit.allowed) {
    try {
      const text = buildRateLimitMessage(rateLimit.retryAfterMs);
      if (args.surface === 'channel') {
        // Ephemeral: rate-limit nags are for the mentioner, not the channel.
        await client.chat.postEphemeral({
          channel: args.channelId,
          user: args.userId,
          thread_ts: args.threadTs,
          text,
        });
      } else {
        await postPlain(args, text);
      }
    } catch (error) {
      logger.warn('Failed to post chat rate-limit notice:', error);
    }
    return 'rate_limited';
  }

  if (args.surface === 'assistant') {
    try {
      await client.assistant.threads.setStatus({
        channel_id: args.channelId,
        thread_ts: args.threadTs,
        status: '💬 Thinking...',
      });
    } catch (error) {
      logger.warn('Failed to set assistant thread status for chat:', error);
    }
  }

  try {
    const contextChannelId =
      args.surface === 'channel' ? args.channelId : (args.viewingChannelId ?? null);
    const [history, channelName] = await Promise.all([
      loadChatHistory(args),
      contextChannelId ? getChannelName(client, contextChannelId) : Promise.resolve(null),
    ]);
    const prompt = buildChatPrompt({
      userMessage: args.userText,
      history,
      surface: args.surface,
      channelName,
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
      await postFullReply(args, reply);
      return 'delivered';
    }

    return await streamChatReply(args, llm, prompt);
  } catch (error) {
    logger.error('General chat reply failed:', error);
    try {
      await client.chat.postMessage({
        channel: args.channelId,
        thread_ts: args.threadTs,
        text: CHAT_FAILURE_TEXT,
        // The nudge buttons only exist on the assistant surface; a channel
        // thread gets plain text.
        ...(args.surface === 'assistant'
          ? { blocks: buildUnknownIntentBlocks(args.viewingChannelId ?? null) }
          : {}),
      });
    } catch (followup) {
      logger.error('Failed to post chat failure fallback:', followup);
    }
    return 'failed';
  }
}

/**
 * Fetch the thread and shape it into chat history: newest {@link HISTORY_LIMIT}
 * first-page messages, sans the triggering message, each entry capped,
 * empty/blocks-only messages dropped. Bot messages carry the bot's own user ID
 * (not a missing `user`), so attribution compares against `auth.test`. On the
 * channel surface, human turns get display names so the model can tell
 * participants apart.
 */
async function loadChatHistory(args: GeneralChatArgs): Promise<ChatHistoryEntry[]> {
  try {
    const [messages, botUserId] = await Promise.all([
      getThreadMessages(args.client, args.channelId, args.threadTs, HISTORY_FETCH_LIMIT),
      getBotUserId(args.client),
    ]);
    const recent = messages
      .filter((m) => m.ts !== args.userMessageTs && m.text.trim().length > 0)
      .slice(-HISTORY_LIMIT);

    // The assistant DM only ever has one human, so the generic "User" label
    // is enough there; a channel thread needs names.
    const nameByUserId = new Map<string, string>();
    if (args.surface === 'channel') {
      const humanIds = [
        ...new Set(
          recent.map((m) => m.user).filter((u): u is string => u !== null && u !== botUserId)
        ),
      ];
      const names = await Promise.all(
        humanIds.map((id) => getUserDisplayName(args.client, id))
      );
      humanIds.forEach((id, i) => nameByUserId.set(id, names[i]));
    }

    return recent.map((m) => {
      const speaker = m.user ? nameByUserId.get(m.user) : undefined;
      return {
        role:
          m.user && m.user !== botUserId ? ('user' as const) : ('assistant' as const),
        text: [...m.text].slice(0, HISTORY_MESSAGE_MAX_CHARS).join(''),
        ...(speaker ? { speaker } : {}),
      };
    });
  } catch (error) {
    // Context is best-effort — answer without it rather than failing.
    args.logger.warn('Failed to load thread history for chat:', error);
    return [];
  }
}

/** Post a complete (non-streamed) reply as a single markdown message. */
async function postFullReply(args: GeneralChatArgs, reply: string): Promise<void> {
  if (reply.trim().length === 0) {
    throw new Error('Empty chat reply from model');
  }
  const body = sanitizeGeneratedSlackMrkdwn(reply);
  await args.client.chat.postMessage({
    channel: args.channelId,
    thread_ts: args.threadTs,
    text: body,
    blocks: [{ type: 'markdown', text: truncateForMarkdownBlock(body) }],
  });
}

/** Drain the model stream to completion and return the full text. */
async function collectStreamText(
  stream: Extract<StreamingResponse, { kind: 'active' }>
): Promise<string> {
  let collected = '';
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
      if (event.kind === 'text_delta') {
        collected += event.delta;
      }
    }
  } finally {
    void stream.cancel();
  }
  return collected;
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

  let streamTs: string;
  try {
    streamTs = await startStream(args.client, {
      channel: args.channelId,
      threadTs: args.threadTs,
      // Slack requires the recipient outside DMs (i.e. on the channel surface).
      ...(args.surface === 'channel'
        ? {
            recipientUserId: args.userId,
            ...(args.recipientTeamId ? { recipientTeamId: args.recipientTeamId } : {}),
          }
        : {}),
    });
  } catch (error) {
    // Streaming can be unavailable (e.g. workspace restrictions). Deliver the
    // reply as one message instead of dead-ending.
    args.logger.warn('chat.startStream failed; posting the reply unstreamed:', error);
    await postFullReply(args, await collectStreamText(stream));
    return 'delivered';
  }

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
      channel: args.channelId,
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
    if (collected.length === 0) {
      throw new Error('Anthropic chat stream completed without any output');
    }
  } catch (error) {
    // Stop and remove the partial (or empty) message before surfacing the
    // failure fallback.
    await stopStream(args.client, {
      channel: args.channelId,
      ts: streamTs,
    }).catch(() => undefined);
    await args.client.chat
      .delete({ channel: args.channelId, ts: streamTs })
      .catch(() => undefined);
    throw error;
  } finally {
    void stream.cancel();
  }

  while (canAppend && pending.length > 0) {
    const wait = args.config.streamMinAppendIntervalMs - (Date.now() - lastAppendAt);
    if (wait > 0) {
      await sleep(wait);
    }
    await appendChunk();
  }

  if (canAppend) {
    await stopStream(args.client, { channel: args.channelId, ts: streamTs });
    return 'delivered';
  }
  return 'stopped';
}

async function postPlain(args: GeneralChatArgs, text: string): Promise<void> {
  await args.client.chat.postMessage({
    channel: args.channelId,
    thread_ts: args.threadTs,
    text,
  });
}
