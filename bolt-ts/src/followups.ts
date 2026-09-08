/**
 * Post-summary follow-up touches.
 *
 * After a summary is delivered, retitle the thread after its source channel.
 * Suggested prompts remain the initial source choices; each result's native
 * menu offers fresh requests because post-result prompts are not always visible.
 */

import type { WebClient } from '@slack/web-api';
import { getChannelName } from './slack/client';
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

export interface PostSummaryFollowUpArgs {
  client: WebClient;
  assistantChannelId: string;
  assistantThreadTs: string;
  sourceChannelId: string;
  logger?: { warn(message: string, meta?: unknown): void };
}

/** Retitle a delivered summary's thread. Never throws. */
export async function applyPostSummaryFollowUps(args: PostSummaryFollowUpArgs): Promise<void> {
  const { client, assistantChannelId, assistantThreadTs, sourceChannelId } = args;
  try {
    const channelName = await getChannelName(client, sourceChannelId);
    const label = channelName === sourceChannelId ? channelName : `#${channelName}`;
    await client.assistant.threads.setTitle({
      channel_id: assistantChannelId,
      thread_ts: assistantThreadTs,
      title: `TLDR — ${label}`,
    });
  } catch (error) {
    args.logger?.warn('Post-summary thread title failed', { error: String(error) });
  }
}
