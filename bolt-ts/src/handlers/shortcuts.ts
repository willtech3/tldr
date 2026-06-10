/**
 * Message shortcut: "Summarize Thread".
 *
 * The app manifest has always declared this shortcut in every message's ⋯
 * menu; this handler makes it real. It summarizes the thread (or single
 * message) in place and replies ephemerally via the shortcut's response_url —
 * only the invoking user sees the result, no channel noise.
 */

import { randomUUID } from 'node:crypto';
import type { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import type { WebClient } from '@slack/web-api';
import { LlmClient, PromptTooLargeError } from '../ai/anthropic';
import type { AppConfig } from '../config';
import { checkSummarizeRateLimit } from '../security';
import { sanitizeGeneratedSlackMrkdwn, truncateForMarkdownBlock } from '../slack/sanitize';
import { BotNotInChannelError, getBotUserId, getThreadMessages } from '../slack/client';
import { applySafetyNetSections, buildSummarizePromptData } from '../worker/prompt_builder';
import { buildRateLimitMessage } from './run_summary';

export const SHORTCUT_SUMMARIZE_THREAD = 'summarize_thread';

const THREAD_TOO_SHORT_MESSAGE =
  '🪹 There is nothing in this thread for me to summarize yet.';
const THREAD_FAILURE_MESSAGE =
  "😅 I couldn't summarize this thread just now. Please try again in a moment.";

type Respond = (message: {
  text: string;
  blocks?: KnownBlock[];
  response_type?: 'ephemeral' | 'in_channel';
}) => Promise<unknown>;

export interface ThreadShortcutPayload {
  userId: string;
  channelId: string;
  /** Parent ts of the thread (falls back to the message itself). */
  threadTs: string;
}

interface RunThreadArgs {
  config: AppConfig;
  client: WebClient;
  payload: ThreadShortcutPayload;
  respond: Respond;
  llm?: LlmClient;
  fetchImpl?: typeof fetch;
  logger?: { error(message: string, ...meta: unknown[]): void };
}

/** Summarize a single thread and deliver the result ephemerally. */
export async function runThreadSummarization(args: RunThreadArgs): Promise<void> {
  const { config, client, payload, respond } = args;
  const log = args.logger ?? console;

  const rateLimit = checkSummarizeRateLimit(payload.userId);
  if (!rateLimit.allowed) {
    await respond({ text: buildRateLimitMessage(rateLimit.retryAfterMs) });
    return;
  }

  const llm =
    args.llm ??
    new LlmClient({
      apiKey: config.anthropicApiKey,
      model: config.anthropicModel,
      maxOutputTokens: config.anthropicMaxOutputTokens,
    });

  const correlationId = randomUUID();
  try {
    const messages = await getThreadMessages(client, payload.channelId, payload.threadTs);
    const botUserId = await getBotUserId(client);
    const threadMessages = botUserId ? messages.filter((m) => m.user !== botUserId) : messages;
    if (threadMessages.length === 0) {
      await respond({ text: THREAD_TOO_SHORT_MESSAGE });
      return;
    }

    const promptData = await buildSummarizePromptData({
      client,
      botToken: config.slackBotToken,
      channelId: payload.channelId,
      messages: threadMessages,
      customStyle: null,
      fetchImpl: args.fetchImpl,
    });

    const summary = await llm.generateSummary(promptData.prompt);
    const body = sanitizeGeneratedSlackMrkdwn(
      `**TLDR of this thread**\n\n` + applySafetyNetSections(summary, promptData)
    );

    await respond({
      text: `Thread summary (${threadMessages.length} messages)`,
      blocks: [
        { type: 'markdown', text: truncateForMarkdownBlock(body) },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `🤖 AI-generated • ${threadMessages.length} thread messages • only visible to you`,
            },
          ],
        },
      ],
    });
  } catch (err) {
    log.error('Thread summarization failed', {
      corr_id: correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
    let text = THREAD_FAILURE_MESSAGE;
    if (err instanceof BotNotInChannelError) {
      text = `🚪 I'm not in <#${payload.channelId}> yet, so I can't read this thread. Run \`/invite @TLDR\` here first.`;
    } else if (err instanceof PromptTooLargeError) {
      text = '📚 This thread is too long for me to summarize in one go.';
    }
    try {
      await respond({ text });
    } catch (followup) {
      log.error('Failed to deliver thread-summary error', followup);
    }
  }
}

export function registerShortcutHandlers(app: App, config: AppConfig): void {
  app.shortcut(SHORTCUT_SUMMARIZE_THREAD, async ({ ack, shortcut, client, respond, logger }) => {
    await ack();
    if (shortcut.type !== 'message_action') {
      return;
    }
    const channelId = shortcut.channel?.id;
    const messageTs = shortcut.message_ts;
    const threadTs = (shortcut.message as { thread_ts?: string } | undefined)?.thread_ts ?? messageTs;
    const userId = shortcut.user?.id;
    if (!channelId || !threadTs || !userId) {
      return;
    }
    await runThreadSummarization({
      config,
      client,
      payload: { userId, channelId, threadTs },
      respond: respond as Respond,
      logger,
    });
  });
}
