/**
 * Channel @-mention handler.
 *
 * Mentioning @TLDR in a channel gets a private recap when the mention is a
 * catch-up (`@TLDR`, `catch me up`, `roast`, `receipts`, `summarize`).
 * Anything else is general chat streamed into the message's thread.
 * Recaps are ephemeral so the channel does not get a second copy of itself.
 *
 * Requires the `app_mention` bot event and `app_mentions:read` scope in the
 * Slack app manifest.
 */

import type { App } from '@slack/bolt';
import type { AppConfig } from '../config';
import { parseUserIntent } from '../intent';
import { normalizeMessageCount, validateAndSanitizeStyle } from '../security';
import { getBotUserId } from '../slack/client';
import { runGeneralChat, type GeneralChatArgs } from '../worker/chat';
import { guardAndRunSummarization, type GuardedSummarizeArgs } from './run_summary';

/** Stands in for the user text when the mention is just "@TLDR". */
export const EMPTY_MENTION_TEXT = '(the user mentioned you without saying anything else)';

/** Remove the bot's own <@U…> mention(s), keeping everyone else's. */
export function stripBotMention(text: string, botUserId: string | null): string {
  if (!botUserId) {
    return text.trim();
  }
  return text.split(`<@${botUserId}>`).join(' ').replace(/\s+/g, ' ').trim();
}

interface MentionEvent {
  channel: string;
  ts: string;
  text?: string;
  user?: string;
  thread_ts?: string;
  team?: string;
  bot_id?: string;
  subtype?: string;
}

export interface HandleMentionArgs {
  event: MentionEvent;
  client: GeneralChatArgs['client'];
  config: AppConfig;
  botUserId: string | null;
  teamId: string | null;
  logger: GeneralChatArgs['logger'];
  /** Test injection point. */
  chat?: typeof runGeneralChat;
  /** Test injection point for catch-up mentions. */
  summarize?: typeof guardAndRunSummarization;
}

/** A bare mention or a summarize/roast/receipts command. Null means keep chatting. */
export function mentionCatchUp(text: string): {
  count: number | null;
  targetChannel: string | null;
  styleOverride: string | null;
} | null {
  if (text.length === 0) {
    return { count: null, targetChannel: null, styleOverride: null };
  }
  const intent = parseUserIntent(text);
  if (intent.type !== 'summarize') {
    return null;
  }
  return {
    count: intent.count,
    targetChannel: intent.targetChannel,
    styleOverride: intent.styleOverride,
  };
}

/** Answer an @-mention with general chat in the message's thread. */
export async function handleAppMention(args: HandleMentionArgs): Promise<void> {
  const { event } = args;
  // Never answer other bots or message edits — no loops, no double replies.
  if (event.bot_id || event.subtype || !event.user) {
    return;
  }

  const stripped = stripBotMention(event.text ?? '', args.botUserId);
  const catchUp = mentionCatchUp(stripped);
  if (catchUp) {
    const validated = validateAndSanitizeStyle(catchUp.styleOverride);
    if (!validated.ok) {
      await args.client.chat.postEphemeral({
        channel: event.channel,
        user: event.user,
        thread_ts: event.thread_ts ?? event.ts,
        text: validated.reason,
      });
      return;
    }
    const summarize = args.summarize ?? guardAndRunSummarization;
    await summarize({
      client: args.client,
      config: args.config,
      userId: event.user,
      sourceChannelId: catchUp.targetChannel ?? event.channel,
      assistantChannelId: event.channel,
      assistantThreadTs: event.thread_ts ?? event.ts,
      messageCount: normalizeMessageCount(catchUp.count),
      customStyle: validated.value,
      ephemeralUserId: event.user,
      logger: args.logger,
    } satisfies GuardedSummarizeArgs);
    return;
  }

  const userText = stripped || EMPTY_MENTION_TEXT;

  await (args.chat ?? runGeneralChat)({
    client: args.client,
    config: args.config,
    userId: event.user,
    surface: 'channel',
    channelId: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    userText,
    userMessageTs: event.ts,
    recipientTeamId: event.team ?? args.teamId,
    logger: args.logger,
  });
}

export function registerMentionHandlers(app: App, config: AppConfig): void {
  app.event('app_mention', async ({ event, client, context, logger }): Promise<void> => {
    await handleAppMention({
      event,
      client,
      config,
      botUserId: context.botUserId ?? (await getBotUserId(client)),
      teamId: context.teamId ?? null,
      logger,
    });
  });
}
