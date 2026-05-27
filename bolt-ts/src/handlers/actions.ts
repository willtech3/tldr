/**
 * Action handlers for the interactive buttons that appear under a summary.
 *
 * Handlers ACK immediately, then either repost a message (Share) or kick off a
 * fresh summarisation inline (Roast, Receipts, message-count selector).
 */

import { App, BlockAction } from '@slack/bolt';
import { v4 as uuidv4 } from 'uuid';
import {
  checkSummarizeRateLimit,
  isUserMemberOfChannel,
  isValidSlackChannelId,
  normalizeMessageCount,
  sanitizeGeneratedSlackText,
  type ConversationsMembersClient,
} from '../security';
import type { ThreadContext } from '../types';
import { ACTION_SELECT_MESSAGE_COUNT, buildWelcomeBlocks } from '../blocks';
import {
  buildThreadStateMetadata,
  findThreadStateMessage,
  getCachedThreadState,
  makeThreadKey,
  setCachedThreadState,
  type SlackWebApiClient,
} from '../thread_state';
import type { AppConfig } from '../config';
import { runSummarization } from '../worker/summarize';

interface ShareButtonValue {
  action: 'share_summary';
  sourceChannelId: string;
  count: number;
  style: string | null;
}

interface RerunButtonValue {
  action: 'rerun_roast' | 'rerun_receipts';
  channelId: string;
  count: number;
}

const ROAST_STYLE =
  'Write in a hyper-critical, sarcastic, and roasting tone. Point out inefficiencies, poor decisions, and ridiculous behavior. Be funny but brutal.';
const RECEIPTS_STYLE =
  'Focus on finding contradictions, broken promises, and receipts. Point out when someone said they would do something and did not, or when people contradicted themselves. Be specific with timestamps and quotes.';

export function registerActionHandlers(app: App, config: AppConfig): void {
  app.action<BlockAction>('share_summary', async ({ ack, body, action, client, logger }) => {
    await ack();
    try {
      if (!action || typeof action !== 'object' || !('type' in action) || action.type !== 'button') {
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buttonValue: ShareButtonValue = JSON.parse((action as any).value || '{}');
      const { sourceChannelId, count: rawCount, style } = buttonValue;
      const count = normalizeMessageCount(rawCount);
      if (!isValidSlackChannelId(sourceChannelId)) {
        return;
      }
      const message = 'message' in body ? body.message : null;
      const channel = 'channel' in body ? body.channel : null;
      if (!message || !channel) {
        return;
      }
      const assistantChannelId = channel.id;
      const threadTs = message.thread_ts ?? message.ts;

      const canRead = await isUserMemberOfChannel({
        client: client as unknown as ConversationsMembersClient,
        channelId: sourceChannelId,
        userId: body.user.id,
        logger,
      });
      if (!canRead) {
        await client.chat.postMessage({
          channel: assistantChannelId,
          thread_ts: threadTs,
          text: "I can only share summaries for channels you're a member of.",
        });
        return;
      }

      const summaryText = sanitizeGeneratedSlackText(message.text || '');
      const attribution = buildShareAttribution(body.user.id, count, style);
      await client.chat.postMessage({
        channel: sourceChannelId,
        text: `${attribution}\n\n${summaryText}`,
      });
      await client.chat.postMessage({
        channel: assistantChannelId,
        thread_ts: threadTs,
        text: `✅ Shared to <#${sourceChannelId}>`,
      });
    } catch (error) {
      logger.error('Failed to handle share_summary action:', error);
    }
  });

  app.action<BlockAction>('rerun_roast', async (args) =>
    handleRerun({ ...args, config, style: ROAST_STYLE, label: '🔥 Running roast mode...' })
  );

  app.action<BlockAction>('rerun_receipts', async (args) =>
    handleRerun({ ...args, config, style: RECEIPTS_STYLE, label: '📜 Pulling receipts...' })
  );

  app.action<BlockAction>(
    ACTION_SELECT_MESSAGE_COUNT,
    async ({ ack, body, action, client, logger }) => {
      await ack();
      try {
        if (!action || typeof action !== 'object' || !('type' in action) || action.type !== 'static_select') {
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const selectedOption = (action as any).selected_option;
        if (!selectedOption || typeof selectedOption.value !== 'string') {
          return;
        }
        const parsed = Number.parseInt(selectedOption.value, 10);
        if (Number.isNaN(parsed)) {
          return;
        }
        const newCount = normalizeMessageCount(parsed);

        const message = 'message' in body ? body.message : null;
        const channel = 'channel' in body ? body.channel : null;
        if (!message || !channel) {
          return;
        }
        const assistantChannelId = channel.id;
        const welcomeMessageTs = message.ts;
        const threadTs = message.thread_ts ?? message.ts;
        const threadKey = makeThreadKey(assistantChannelId, threadTs);

        let currentState: ThreadContext = {
          viewingChannelId: null,
          customStyle: null,
          defaultMessageCount: null,
        };
        const cached = getCachedThreadState(threadKey);
        if (cached) {
          currentState = cached.state;
        } else {
          try {
            const loaded = await findThreadStateMessage({
              client: client as unknown as SlackWebApiClient,
              assistantChannelId,
              assistantThreadTs: threadTs,
            });
            if (loaded) {
              currentState = loaded.state;
            }
          } catch (error) {
            logger.warn('Failed to load thread state from Slack:', error);
          }
        }

        const nextState: ThreadContext = { ...currentState, defaultMessageCount: newCount };

        await client.chat.update({
          channel: assistantChannelId,
          ts: welcomeMessageTs,
          text: 'Welcome to TLDR',
          blocks: buildWelcomeBlocks(
            nextState.viewingChannelId,
            nextState.customStyle,
            nextState.defaultMessageCount
          ),
          metadata: buildThreadStateMetadata(nextState),
        });
        setCachedThreadState({
          threadKey,
          stateMessageTs: welcomeMessageTs,
          state: nextState,
        });
      } catch (error) {
        logger.error('Failed to handle message count selection:', error);
      }
    }
  );
}

function buildShareAttribution(userId: string, count: number, style: string | null): string {
  const lower = style?.toLowerCase() ?? '';
  if (lower.includes('roast')) {
    return `<@${userId}> chose violence and asked TLDR to roast the last ${count} messages:`;
  }
  if (lower.includes('receipt')) {
    return `<@${userId}> asked TLDR to pull receipts from the last ${count} messages:`;
  }
  return `<@${userId}> asked TLDR to summarize the last ${count} messages:`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RerunArgs = any & {
  config: AppConfig;
  style: string;
  label: string;
};

async function handleRerun(args: RerunArgs): Promise<void> {
  const { ack, body, action, client, logger, config, style, label } = args;
  await ack();
  try {
    if (!action || typeof action !== 'object' || !('type' in action) || action.type !== 'button') {
      return;
    }
    const buttonValue: RerunButtonValue = JSON.parse(action.value || '{}');
    const { channelId, count: rawCount } = buttonValue;
    const count = normalizeMessageCount(rawCount);
    if (!isValidSlackChannelId(channelId)) {
      return;
    }
    const message = 'message' in body ? body.message : null;
    const channel = 'channel' in body ? body.channel : null;
    if (!message || !channel) {
      return;
    }
    const assistantChannelId = channel.id;
    const threadTs = message.thread_ts ?? message.ts;

    if (!checkSummarizeRateLimit(body.user.id)) {
      await client.chat.postMessage({
        channel: assistantChannelId,
        thread_ts: threadTs,
        text: 'Please wait a minute before starting more summaries.',
      });
      return;
    }

    const canRead = await isUserMemberOfChannel({
      client: client as unknown as ConversationsMembersClient,
      channelId,
      userId: body.user.id,
      logger,
    });
    if (!canRead) {
      await client.chat.postMessage({
        channel: assistantChannelId,
        thread_ts: threadTs,
        text: "I can only summarize channels you're a member of.",
      });
      return;
    }

    await client.chat.postMessage({
      channel: assistantChannelId,
      thread_ts: threadTs,
      text: label,
    });

    await runSummarization({
      config,
      client,
      request: {
        correlationId: uuidv4(),
        userId: body.user.id,
        channelId,
        originChannelId: assistantChannelId,
        threadTs,
        messageCount: count,
        customStyle: style,
      },
    });
  } catch (error) {
    logger.error('Failed to handle rerun action:', error);
  }
}
