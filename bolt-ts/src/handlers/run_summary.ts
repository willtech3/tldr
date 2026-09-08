/**
 * Shared guard → status → run → follow-ups pipeline.
 *
 * Every entry point that starts a summarization (typed commands, the welcome
 * button, retry buttons, roast/receipts reruns) funnels through here so rate
 * limiting, membership checks, the animated thread status, and post-summary
 * follow-up prompts behave identically everywhere.
 */

import { randomUUID } from 'node:crypto';
import type { WebClient } from '@slack/web-api';
import type { AppConfig } from '../config';
import { applyPostSummaryFollowUps } from '../followups';
import { buildSummarizeLoadingMessages } from '../loading_messages';
import {
  RATE_LIMIT_MAX_PER_MINUTE,
  checkChannelMembership,
  checkSummarizeRateLimit,
  isValidSlackChannelId,
  type ConversationsMembersClient,
} from '../security';
import { runSummarization } from '../worker/summarize';
import type { SummaryWindow } from '../types';
import { parseSummaryWindow } from '../summary_window';
import { isValidSummaryToShorten, MAX_CUSTOM_STYLE_LENGTH } from '../ai/prompt';

export const NOT_A_MEMBER_MESSAGE = "🔒 I can only summarize channels you're a member of.";
export const MEMBERSHIP_UNKNOWN_MESSAGE =
  "🤷 I couldn't verify your channel membership just now — give it another try in a moment.";
export const INVALID_CHANNEL_MESSAGE =
  "Hmm, that doesn't look like a channel I can read — try picking it with `#` autocomplete.";

export function buildRateLimitMessage(retryAfterMs: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return `⏳ Easy there — I cap at ${RATE_LIMIT_MAX_PER_MINUTE} requests a minute. Try again in ~${seconds}s.`;
}

interface HandlerLogger {
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

export interface GuardedSummarizeArgs {
  client: WebClient;
  config: AppConfig;
  userId: string;
  /** Channel whose history gets summarized. */
  sourceChannelId: string;
  /** Assistant DM channel + thread the reply goes to. */
  assistantChannelId: string;
  assistantThreadTs: string;
  messageCount: number;
  customStyle: string | null;
  window?: SummaryWindow;
  shorter?: boolean;
  /** Visible original recap, passed transiently to the model only. */
  summaryToShorten?: string;
  /** Status line Slack shows while rotating loading messages. */
  statusText?: string;
  /** Persist an explicitly selected source only after membership is verified. */
  beforeRun?: () => Promise<void>;
  logger: HandlerLogger;
}

/**
 * Validate, show progress, run the summary, then refresh follow-up prompts.
 * Posts a user-facing message for every refusal; never throws.
 */
export async function guardAndRunSummarization(args: GuardedSummarizeArgs): Promise<void> {
  const { client, config, logger } = args;

  const reply = async (text: string): Promise<void> => {
    await client.chat.postMessage({
      channel: args.assistantChannelId,
      thread_ts: args.assistantThreadTs,
      text,
    });
  };

  if (!isValidSlackChannelId(args.sourceChannelId)) {
    await reply(INVALID_CHANNEL_MESSAGE);
    return;
  }

  if (args.window !== undefined && !parseSummaryWindow(args.window)) {
    await reply('This summary has no usable saved time window. Refresh the source before trying again.');
    return;
  }
  if (!Number.isInteger(args.messageCount) || args.messageCount < 1 || args.messageCount > 500) {
    await reply('Choose a message count from 1 to 500 before summarizing.');
    return;
  }

  if ((args.shorter !== undefined && typeof args.shorter !== 'boolean') ||
      (args.customStyle !== null && (typeof args.customStyle !== 'string' || args.customStyle.length > MAX_CUSTOM_STYLE_LENGTH))) {
    await reply('These summary settings are invalid. Refresh the source before trying again.');
    return;
  }
  if (args.summaryToShorten !== undefined &&
      (!isValidSummaryToShorten(args.summaryToShorten) || args.shorter !== true || args.window === undefined)) {
    await reply('This recap cannot be shortened safely. Use Shorter on the original summary, or refresh the source.');
    return;
  }

  const rateLimit = checkSummarizeRateLimit(args.userId);
  if (!rateLimit.allowed) {
    await reply(buildRateLimitMessage(rateLimit.retryAfterMs));
    return;
  }

  const membership = await checkChannelMembership({
    client: client as unknown as ConversationsMembersClient,
    channelId: args.sourceChannelId,
    userId: args.userId,
    logger,
  });
  if (membership !== 'member') {
    await reply(membership === 'unknown' ? MEMBERSHIP_UNKNOWN_MESSAGE : NOT_A_MEMBER_MESSAGE);
    return;
  }

  if (args.beforeRun) {
    try {
      await args.beforeRun();
    } catch (error) {
      logger.error('Failed to save summary settings:', error);
      await reply("I couldn't save that source. Please choose it again before summarizing.");
      return;
    }
  }

  // No explicit clear needed: Slack auto-clears this status as soon as the
  // pipeline posts its next message in the thread, and every outcome posts
  // one (the streamed summary header arrives before any tokens; failures
  // post or repair a message of their own).
  const hasCustomStyle = args.customStyle !== null && args.customStyle.trim().length > 0;
  try {
    await client.assistant.threads.setStatus({
      channel_id: args.assistantChannelId,
      thread_ts: args.assistantThreadTs,
      status: args.statusText ?? 'Summarizing...',
      loading_messages: buildSummarizeLoadingMessages({
        messageCount: args.messageCount,
        hasCustomStyle,
      }),
    });
  } catch (error) {
    logger.warn('Failed to set assistant thread status:', error);
  }

  const correlationId = randomUUID();
  const outcome = await runSummarization({
    config,
    client,
    request: {
      correlationId,
      userId: args.userId,
      channelId: args.sourceChannelId,
      originChannelId: args.assistantChannelId,
      threadTs: args.assistantThreadTs,
      messageCount: args.messageCount,
      customStyle: args.customStyle,
      window: args.window,
      shorter: args.shorter,
      summaryToShorten: args.summaryToShorten,
    },
  });

  if (outcome === 'delivered') {
    await applyPostSummaryFollowUps({
      client,
      assistantChannelId: args.assistantChannelId,
      assistantThreadTs: args.assistantThreadTs,
      sourceChannelId: args.sourceChannelId,
      style: args.customStyle,
      messageCount: args.messageCount,
      logger,
    });
  }
}
