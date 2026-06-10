/**
 * Post-summary follow-up touches.
 *
 * After a summary is delivered we refresh the assistant thread's suggested
 * prompts so the obvious next actions (roast, receipts, go deeper, refresh)
 * are one tap away, and retitle the thread after its source channel so it is
 * findable in the AI pane's history. Both calls are best-effort — a failure
 * never affects the delivered summary.
 */

import type { WebClient } from '@slack/web-api';
import { getChannelName } from './slack/client';
import { isReceiptsStyle, isRoastStyle, RECEIPTS_STYLE, ROAST_STYLE } from './styles';

export interface FollowUpPrompt {
  title: string;
  message: string;
}

/** Slack shows at most 4 suggested prompts. */
const MAX_PROMPTS = 4;

/**
 * Build follow-up prompts for the just-delivered summary. The prompt that
 * matches the style we just used is dropped (no point offering a rerun of the
 * same thing) and replaced with a plain refresh.
 */
export function buildFollowUpPrompts(style: string | null): FollowUpPrompt[] {
  const prompts: FollowUpPrompt[] = [];

  if (!isRoastStyle(style)) {
    prompts.push({
      title: '🔥 Roast it instead',
      message: `summarize with style: ${ROAST_STYLE}`,
    });
  }
  if (!isReceiptsStyle(style)) {
    prompts.push({
      title: '📜 Pull the receipts',
      message: `summarize with style: ${RECEIPTS_STYLE}`,
    });
  }
  prompts.push({ title: '🔍 Go deeper — last 200', message: 'summarize last 200' });
  prompts.push({ title: '🔄 Fresh take', message: 'summarize' });

  return prompts.slice(0, MAX_PROMPTS);
}

export interface PostSummaryFollowUpArgs {
  client: WebClient;
  assistantChannelId: string;
  assistantThreadTs: string;
  sourceChannelId: string;
  /** Style used for the summary that was just delivered. */
  style: string | null;
  logger?: { warn(message: string, meta?: unknown): void };
}

/**
 * Refresh suggested prompts and the thread title after a delivered summary.
 * Never throws.
 */
export async function applyPostSummaryFollowUps(args: PostSummaryFollowUpArgs): Promise<void> {
  const { client, assistantChannelId, assistantThreadTs, sourceChannelId, style } = args;
  const warn = (message: string, meta?: unknown): void => args.logger?.warn(message, meta);

  const results = await Promise.allSettled([
    client.assistant.threads.setSuggestedPrompts({
      channel_id: assistantChannelId,
      thread_ts: assistantThreadTs,
      title: 'What next?',
      prompts: buildFollowUpPrompts(style) as [FollowUpPrompt, ...FollowUpPrompt[]],
    }),
    (async (): Promise<void> => {
      const channelName = await getChannelName(client, sourceChannelId);
      const label = channelName === sourceChannelId ? channelName : `#${channelName}`;
      await client.assistant.threads.setTitle({
        channel_id: assistantChannelId,
        thread_ts: assistantThreadTs,
        title: `TLDR — ${label}`,
      });
    })(),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') {
      warn('Post-summary follow-up failed', { error: String(result.reason) });
    }
  }
}
