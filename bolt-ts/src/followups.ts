/**
 * Post-summary follow-up touches.
 *
 * After a summary is delivered we refresh the assistant thread's suggested
 * prompts for explicitly fetching newer or more messages, and retitle the
 * thread after its source channel so it is findable in the AI pane's history. Both calls are best-effort — a failure
 * never affects the delivered summary.
 */

import type { WebClient } from '@slack/web-api';
import { getChannelName } from './slack/client';
import { normalizeMessageCount } from './security';
import { RECEIPTS_STYLE, ROAST_STYLE } from './styles';

export interface FollowUpPrompt {
  title: string;
  message: string;
}

/** Initial choices always name their source, even if thread context changes. */
export function buildSourcePrompts(channelId: string | null): FollowUpPrompt[] {
  if (!channelId) {
    return [{ title: 'How to use TLDR', message: 'help' }];
  }
  const summarize = `summarize <#${channelId}>`;
  return [
    { title: 'Catch up', message: summarize },
    { title: 'Roast', message: `${summarize} with style: ${ROAST_STYLE}` },
    { title: 'Receipts', message: `${summarize} with style: ${RECEIPTS_STYLE}` },
  ];
}

/**
 * The summary's buttons transform its original window. Suggested prompts
 * instead make an explicit fresh request, with a source and count that do
 * not depend on mutable thread defaults.
 */
export function buildFollowUpPrompts(sourceChannelId: string, messageCount: number): FollowUpPrompt[] {
  const count = normalizeMessageCount(messageCount);
  const prompts = [{
    title: `Refresh latest ${count}`,
    message: `summarize <#${sourceChannelId}> last ${count}`,
  }];
  if (count < 500) {
    const expandedCount = Math.min(500, Math.max(200, (Math.floor(count / 100) + 1) * 100));
    prompts.push({
      title: `Expand to latest ${expandedCount}`,
      message: `summarize <#${sourceChannelId}> last ${expandedCount}`,
    });
  }
  return prompts;
}

export interface PostSummaryFollowUpArgs {
  client: WebClient;
  assistantChannelId: string;
  assistantThreadTs: string;
  sourceChannelId: string;
  messageCount: number;
  /** Accepted for callers that still supply the delivered summary's style. */
  style?: string | null;
  logger?: { warn(message: string, meta?: unknown): void };
}

/**
 * Refresh suggested prompts and the thread title after a delivered summary.
 * Never throws.
 */
export async function applyPostSummaryFollowUps(args: PostSummaryFollowUpArgs): Promise<void> {
  const { client, assistantChannelId, assistantThreadTs, sourceChannelId, messageCount } = args;
  const warn = (message: string, meta?: unknown): void => args.logger?.warn(message, meta);

  const results = await Promise.allSettled([
    client.assistant.threads.setSuggestedPrompts({
      channel_id: assistantChannelId,
      thread_ts: assistantThreadTs,
      title: 'Get the latest',
      prompts: buildFollowUpPrompts(sourceChannelId, messageCount) as [FollowUpPrompt, ...FollowUpPrompt[]],
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
