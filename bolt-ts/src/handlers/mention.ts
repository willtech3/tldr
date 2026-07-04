/**
 * Channel @-mention handler.
 *
 * Mentioning @TLDR in a channel gets a general-chat reply streamed into the
 * message's thread — the same engine as assistant-thread chat, text in / text
 * out only. Summarization stays on its existing surfaces (the assistant pane
 * and the Summarize Thread shortcut); the chat prompt knows to point users
 * there when they ask.
 *
 * Requires the `app_mention` bot event and `app_mentions:read` scope in the
 * Slack app manifest.
 */

import type { App } from '@slack/bolt';
import type { AppConfig } from '../config';
import { getBotUserId } from '../slack/client';
import { runGeneralChat, type GeneralChatArgs } from '../worker/chat';

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
}

/** Answer an @-mention with general chat in the message's thread. */
export async function handleAppMention(args: HandleMentionArgs): Promise<void> {
  const { event } = args;
  // Never answer other bots or message edits — no loops, no double replies.
  if (event.bot_id || event.subtype || !event.user) {
    return;
  }

  const userText = stripBotMention(event.text ?? '', args.botUserId) || EMPTY_MENTION_TEXT;

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
