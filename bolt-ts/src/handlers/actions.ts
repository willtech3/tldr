/**
 * Action handlers for the interactive buttons in the assistant thread.
 *
 * Handlers ACK immediately, then either repost a message (Share), show help,
 * or kick off a fresh summarisation inline (quick summarize, retry, Roast,
 * Receipts, message-count selector). All summarisation entry points share the
 * guard → status → run → follow-ups pipeline in `run_summary.ts`.
 */

import { App, BlockAction } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import {
  checkChannelMembership,
  isValidSlackChannelId,
  normalizeMessageCount,
  type ConversationsMembersClient,
} from '../security';
import type { ThreadContext } from '../types';
import {
  ACTION_QUICK_SUMMARIZE,
  ACTION_RETRY_SUMMARY,
  ACTION_SELECT_MESSAGE_COUNT,
  ACTION_SELECT_SOURCE,
  ACTION_SHOW_HELP,
  buildHelpBlocks,
  buildWelcomeBlocks,
  type RetrySummaryValue,
} from '../blocks';
import { ACTION_SUMMARY_FEEDBACK, type StyleKind } from '../worker/deliver';
import { sanitizeGeneratedSlackMrkdwn, truncateForMarkdownBlock } from '../slack/sanitize';
import { RECEIPTS_STYLE, ROAST_STYLE } from '../styles';
import {
  buildThreadStateMetadata,
  loadThreadStateWithFallback,
  makeThreadKey,
  setCachedThreadState,
  type SlackWebApiClient,
} from '../thread_state';
import type { AppConfig } from '../config';
import { guardAndRunSummarization, MEMBERSHIP_UNKNOWN_MESSAGE } from './run_summary';

interface ShareButtonValue {
  action: 'share_summary';
  sourceChannelId: string;
  count: number;
  styleKind?: StyleKind;
}

interface RerunButtonValue {
  action: 'rerun_roast' | 'rerun_receipts';
  channelId: string;
  count: number;
}

export function registerActionHandlers(app: App, config: AppConfig): void {
  app.action<BlockAction>('share_summary', async ({ ack, body, action, client, logger }) => {
    await ack();
    const message = 'message' in body ? body.message : null;
    const channel = 'channel' in body ? body.channel : null;
    if (!message || !channel) {
      return;
    }
    const assistantChannelId = channel.id;
    const threadTs = message.thread_ts ?? message.ts;
    try {
      if (!action || typeof action !== 'object' || !('type' in action) || action.type !== 'button') {
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buttonValue: ShareButtonValue = JSON.parse((action as any).value || '{}');
      const { sourceChannelId, count: rawCount } = buttonValue;
      const count = normalizeMessageCount(rawCount);
      if (!isValidSlackChannelId(sourceChannelId)) {
        return;
      }

      const membership = await checkChannelMembership({
        client: client as unknown as ConversationsMembersClient,
        channelId: sourceChannelId,
        userId: body.user.id,
        logger,
      });
      if (membership !== 'member') {
        await client.chat.postMessage({
          channel: assistantChannelId,
          thread_ts: threadTs,
          text:
            membership === 'unknown'
              ? MEMBERSHIP_UNKNOWN_MESSAGE
              : "I can only share summaries for channels you're a member of.",
        });
        return;
      }

      const summaryText = stripSummaryHeader(
        sanitizeGeneratedSlackMrkdwn(extractSummaryBody(message))
      );
      if (summaryText.length === 0) {
        await client.chat.postMessage({
          channel: assistantChannelId,
          thread_ts: threadTs,
          text: "😅 I couldn't find the summary text on that message to share.",
        });
        return;
      }
      const attribution = buildShareAttribution(body.user.id, count, buttonValue.styleKind);
      // The summary body is standard Markdown — post it via a markdown block
      // so it renders correctly in the channel; the attribution line is
      // mrkdwn so the <@user> mention resolves.
      const shareBlocks: KnownBlock[] = [
        { type: 'section', text: { type: 'mrkdwn', text: attribution } },
        { type: 'markdown', text: truncateForMarkdownBlock(summaryText) },
      ];
      await client.chat.postMessage({
        channel: sourceChannelId,
        text: attribution,
        blocks: shareBlocks,
      });
      await client.chat.postMessage({
        channel: assistantChannelId,
        thread_ts: threadTs,
        text: `✅ Shared to <#${sourceChannelId}>`,
      });
    } catch (error) {
      logger.error('Failed to handle share_summary action:', error);
      try {
        await client.chat.postMessage({
          channel: assistantChannelId,
          thread_ts: threadTs,
          text: "😅 Couldn't share that summary just now — give it another try.",
        });
      } catch (followup) {
        logger.error('Failed to notify user of share failure:', followup);
      }
    }
  });

  app.action<BlockAction>('rerun_roast', async (args) =>
    handleRerun({ ...args, config, style: ROAST_STYLE, statusText: '🔥 Roasting...' })
  );

  app.action<BlockAction>('rerun_receipts', async (args) =>
    handleRerun({ ...args, config, style: RECEIPTS_STYLE, statusText: '📜 Pulling receipts...' })
  );

  // One-tap summarize from the welcome message, style confirmations, and the
  // unknown-intent nudge. Uses the thread's saved defaults at click time.
  app.action<BlockAction>(ACTION_QUICK_SUMMARIZE, async ({ ack, body, client, logger }) => {
    await ack();
    try {
      const message = 'message' in body ? body.message : null;
      const channel = 'channel' in body ? body.channel : null;
      if (!message || !channel) {
        return;
      }
      const assistantChannelId = channel.id;
      const threadTs = message.thread_ts ?? message.ts;

      const state = await loadThreadStateWithFallback({
        client: client as unknown as SlackWebApiClient,
        assistantChannelId,
        assistantThreadTs: threadTs,
        logger,
      });
      if (!state.viewingChannelId) {
        await client.chat.postMessage({
          channel: assistantChannelId,
          thread_ts: threadTs,
          text:
            "Choose a source channel above, or type `summarize #channel`. That source stays set for this thread.",
        });
        return;
      }

      await guardAndRunSummarization({
        client,
        config,
        userId: body.user.id,
        sourceChannelId: state.viewingChannelId,
        assistantChannelId,
        assistantThreadTs: threadTs,
        messageCount: normalizeMessageCount(state.defaultMessageCount),
        customStyle: state.customStyle,
        logger,
      });
    } catch (error) {
      logger.error('Failed to handle quick summarize action:', error);
    }
  });

  // Retry button under a failed summary — replays the original request.
  app.action<BlockAction>(ACTION_RETRY_SUMMARY, async ({ ack, body, action, client, logger }) => {
    await ack();
    try {
      if (!action || typeof action !== 'object' || !('type' in action) || action.type !== 'button') {
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const retry: RetrySummaryValue = JSON.parse((action as any).value || '{}');
      const message = 'message' in body ? body.message : null;
      const channel = 'channel' in body ? body.channel : null;
      if (!message || !channel) {
        return;
      }
      const assistantChannelId = channel.id;
      const threadTs = message.thread_ts ?? message.ts;

      // Styles too long for the button value aren't inlined — recover the
      // thread's saved style instead.
      let customStyle = retry.style ?? null;
      if (customStyle === null && retry.useThreadStyle) {
        const state = await loadThreadStateWithFallback({
          client: client as unknown as SlackWebApiClient,
          assistantChannelId,
          assistantThreadTs: threadTs,
          logger,
        });
        customStyle = state.customStyle;
      }

      await guardAndRunSummarization({
        client,
        config,
        userId: body.user.id,
        sourceChannelId: retry.channelId,
        assistantChannelId,
        assistantThreadTs: threadTs,
        messageCount: normalizeMessageCount(retry.count),
        customStyle,
        statusText: '🔄 Taking another run at it...',
        logger,
      });
    } catch (error) {
      logger.error('Failed to handle retry summary action:', error);
    }
  });

  // Thumbs up/down under every summary. Slack renders the selection natively;
  // we record the signal for quality tracking.
  app.action<BlockAction>(ACTION_SUMMARY_FEEDBACK, async ({ ack, body, action, logger }) => {
    await ack();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const value = (action as any)?.value ?? '';
    logger.info('Summary feedback received', {
      user: body.user?.id,
      verdict: typeof value === 'string' ? value.split(':', 1)[0] : 'unknown',
      value,
    });
  });

  app.action<BlockAction>(ACTION_SHOW_HELP, async ({ ack, body, client, logger }) => {
    await ack();
    try {
      const message = 'message' in body ? body.message : null;
      const channel = 'channel' in body ? body.channel : null;
      if (!message || !channel) {
        return;
      }
      await client.chat.postMessage({
        channel: channel.id,
        thread_ts: message.thread_ts ?? message.ts,
        text: 'TLDR Bot Help',
        blocks: buildHelpBlocks(),
      });
    } catch (error) {
      logger.error('Failed to handle show help action:', error);
    }
  });

  app.action<BlockAction>(ACTION_SELECT_SOURCE, async ({ ack, body, action, client, logger }) => {
    await ack();
    const message = 'message' in body ? body.message : null;
    const channel = 'channel' in body ? body.channel : null;
    if (!message || !channel || action.type !== 'conversations_select') {
      return;
    }
    const selectedChannel = action.selected_conversation;
    const threadTs = message.thread_ts ?? message.ts;
    const reply = async (text: string): Promise<void> => {
      await client.chat.postMessage({ channel: channel.id, thread_ts: threadTs, text });
    };
    try {
      if (!isValidSlackChannelId(selectedChannel)) {
        await reply('Choose a valid source channel.');
        return;
      }
      const membership = await checkChannelMembership({
        client: client as unknown as ConversationsMembersClient,
        channelId: selectedChannel,
        userId: body.user.id,
        logger,
      });
      if (membership !== 'member') {
        await reply(membership === 'unknown'
          ? MEMBERSHIP_UNKNOWN_MESSAGE
          : "I can only use channels you're a member of. Your saved source hasn't changed.");
        return;
      }
      const currentState = await loadThreadStateWithFallback({
        client: client as unknown as SlackWebApiClient,
        assistantChannelId: channel.id,
        assistantThreadTs: threadTs,
        logger,
        requireSuccessfulRead: true,
      });
      const nextState: ThreadContext = { ...currentState, viewingChannelId: selectedChannel };
      await client.chat.update({
        channel: channel.id,
        ts: message.ts,
        text: 'TLDR source and style',
        blocks: buildWelcomeBlocks(selectedChannel, nextState.customStyle, nextState.defaultMessageCount),
        metadata: buildThreadStateMetadata(nextState),
      });
      setCachedThreadState({
        threadKey: makeThreadKey(channel.id, threadTs),
        stateMessageTs: message.ts,
        state: nextState,
      });
    } catch (error) {
      logger.error('Failed to save source channel:', error);
      await reply("I couldn't save that source. Please choose it again before summarizing.");
    }
  });

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

        const currentState = await loadThreadStateWithFallback({
          client: client as unknown as SlackWebApiClient,
          assistantChannelId,
          assistantThreadTs: threadTs,
          logger,
          requireSuccessfulRead: true,
        });
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

/**
 * Pull the summary body out of a summary message. Non-streaming summaries
 * carry the body in a markdown block (their `text` is only a notification
 * fallback); streamed summaries keep it in `text`.
 */
function extractSummaryBody(message: {
  text?: string;
  blocks?: Array<{ type?: string; text?: unknown }>;
}): string {
  const markdownBlock = message.blocks?.find(
    (b) => b?.type === 'markdown' && typeof b.text === 'string'
  );
  if (markdownBlock) {
    return markdownBlock.text as string;
  }
  return message.text ?? '';
}

/**
 * Strip the summary message's own header lines (style + "Summary of #…")
 * before resharing — the share message carries its own attribution. Tolerates
 * both the markdown source (`**…**`) and an mrkdwn-rendered copy (`*…*`).
 */
export function stripSummaryHeader(text: string): string {
  return text
    .replace(/^_Style: [^\n]*_\s*\n+/, '')
    .replace(/^\*{1,2}Summary of [^\n]*\*{1,2}\s*\n+/, '')
    .trimStart();
}

function buildShareAttribution(userId: string, count: number, kind: StyleKind = 'default'): string {
  if (kind === 'roast') {
    return `<@${userId}> chose violence and asked TLDR to roast the last ${count} messages:`;
  }
  if (kind === 'receipts') {
    return `<@${userId}> asked TLDR to pull receipts from the last ${count} messages:`;
  }
  return `<@${userId}> asked TLDR to summarize the last ${count} messages:`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RerunArgs = any & {
  config: AppConfig;
  style: string;
  statusText: string;
};

async function handleRerun(args: RerunArgs): Promise<void> {
  const { ack, body, action, client, logger, config, style, statusText } = args;
  await ack();
  try {
    if (!action || typeof action !== 'object' || !('type' in action) || action.type !== 'button') {
      return;
    }
    const buttonValue: RerunButtonValue = JSON.parse(action.value || '{}');
    const { channelId, count: rawCount } = buttonValue;
    const message = 'message' in body ? body.message : null;
    const channel = 'channel' in body ? body.channel : null;
    if (!message || !channel) {
      return;
    }

    await guardAndRunSummarization({
      client,
      config,
      userId: body.user.id,
      sourceChannelId: channelId,
      assistantChannelId: channel.id,
      assistantThreadTs: message.thread_ts ?? message.ts,
      messageCount: normalizeMessageCount(rawCount),
      customStyle: style,
      statusText,
      logger,
    });
  } catch (error) {
    logger.error('Failed to handle rerun action:', error);
  }
}
