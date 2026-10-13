/**
 * Post-summary follow-up touches.
 *
 * After a summary is delivered, retitle the thread after its source channel.
 * Suggested prompts remain the initial source choices; each result's native
 * menu offers fresh requests because post-result prompts are not always visible.
 */

import type { WebClient } from '@slack/web-api';
import { getChannelName } from './slack/client';

export interface FollowUpPrompt {
  title: string;
  message: string;
}

/**
 * Initial choices name their source. The message is a short command — the
 * intent parser maps roast/receipts onto the preset. The style paragraph
 * never appears as the user's own message.
 */
export function buildSourcePrompts(channelId: string | null): FollowUpPrompt[] {
  if (!channelId) {
    return [
      { title: 'Catch up', message: 'catch up' },
      { title: 'Roast', message: 'roast' },
    ];
  }
  const channel = `<#${channelId}>`;
  return [
    { title: 'Catch up', message: `catch up ${channel}` },
    { title: 'Roast', message: `roast ${channel}` },
    { title: 'Receipts', message: `receipts ${channel}` },
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
