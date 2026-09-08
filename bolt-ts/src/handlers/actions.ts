/**
 * Action handlers for the interactive buttons in the assistant thread.
 *
 * Handlers ACK immediately, then either repost a message (Share), show help,
 * or run a fresh catch-up or a transformation of a saved summary window. All summarisation entry points share the
 * guard → status → run → follow-ups pipeline in `run_summary.ts`.
 */

import { App, BlockAction, type AllMiddlewareArgs, type SlackActionMiddlewareArgs } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import {
  checkChannelMembership,
  isValidSlackChannelId,
  normalizeMessageCount,
  validateAndSanitizeStyle,
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
import { ACTION_SUMMARY_FEEDBACK, type StyleKind, type SummaryTransformValue } from '../worker/deliver';
import { parseSummaryWindow } from '../summary_window';
import { buildSourcePrompts } from '../followups';
import { getMessagePermalink } from '../slack/client';
import { isValidSummaryToShorten } from '../ai/prompt';
import { sanitizeGeneratedSlackMrkdwn, truncateForMarkdownBlock } from '../slack/sanitize';
import { RECEIPTS_STYLE, ROAST_STYLE, STYLE_PRESETS, DEFAULT_STYLE_PRESET_KEY, resolveStylePreset } from '../styles';
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
      const shared = await client.chat.postMessage({
        channel: sourceChannelId,
        text: attribution,
        blocks: shareBlocks,
      });
      const permalink = shared.ts ? await getMessagePermalink(client, sourceChannelId, shared.ts) : null;
      try {
        await client.chat.postMessage({
          channel: assistantChannelId,
          thread_ts: threadTs,
          text: `Shared to <#${sourceChannelId}>${permalink ? ` · <${permalink}|View message>` : ''}`,
        });
      } catch (error) {
        // The public post succeeded. A failed private confirmation must not
        // tell the user to retry the public post and create a duplicate.
        logger.warn('Summary shared, but the private confirmation failed:', error);
      }
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
    handleRerun({ ...args, config, transformAction: 'rerun_roast', style: ROAST_STYLE, statusText: 'Roasting the same conversation...' })
  );

  app.action<BlockAction>('rerun_receipts', async (args) =>
    handleRerun({ ...args, config, transformAction: 'rerun_receipts', style: RECEIPTS_STYLE, statusText: 'Checking the same conversation for receipts...' })
  );

  app.action<BlockAction>('rerun_shorter', async (args) =>
    handleRerun({ ...args, config, transformAction: 'rerun_shorter', style: null, statusText: 'Making that recap shorter...' })
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

      if (!isValidSlackChannelId(retry.channelId) || !Number.isInteger(retry.count) || retry.count < 1 || retry.count > 500 ||
        (retry.styleKey !== undefined && retry.styleKey !== DEFAULT_STYLE_PRESET_KEY && !STYLE_PRESETS.some((preset) => preset.key === retry.styleKey)) ||
        (retry.shorter !== undefined && typeof retry.shorter !== 'boolean')) {
        await client.chat.postMessage({ channel: assistantChannelId, thread_ts: threadTs,
          text: 'That retry has invalid saved settings. Refresh the source before trying again.' });
        return;
      }
      if (retry.requiresOriginal) {
        await client.chat.postMessage({ channel: assistantChannelId, thread_ts: threadTs,
          text: retry.window
            ? 'Retry the action on the original summary to keep its custom style and saved time window.'
            : 'Repeat your original request to retry with the same custom style.' });
        return;
      }
      if (retry.window !== undefined && !parseSummaryWindow(retry.window)) {
        await client.chat.postMessage({ channel: assistantChannelId, thread_ts: threadTs,
          text: 'That retry has no valid saved time window. Refresh the source before trying again.' });
        return;
      }
      let customStyle = retry.styleKey ? resolveStylePreset(retry.styleKey) : retry.style ?? null;
      if (customStyle === null && retry.useThreadStyle) {
        const state = await loadThreadStateWithFallback({
          client: client as unknown as SlackWebApiClient, assistantChannelId,
          assistantThreadTs: threadTs, logger, requireSuccessfulRead: true,
        });
        customStyle = state.customStyle;
      }
      const validatedStyle = validateAndSanitizeStyle(customStyle);
      if (!validatedStyle.ok) {
        await client.chat.postMessage({ channel: assistantChannelId, thread_ts: threadTs, text: validatedStyle.reason });
        return;
      }

      await guardAndRunSummarization({
        client,
        config,
        userId: body.user.id,
        sourceChannelId: retry.channelId,
        assistantChannelId,
        assistantThreadTs: threadTs,
        messageCount: retry.count,
        customStyle: validatedStyle.value,
        window: retry.window,
        shorter: retry.shorter,
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
      try {
        await client.assistant.threads.setSuggestedPrompts({
          channel_id: channel.id, thread_ts: threadTs, title: 'Catch up on your source',
          prompts: buildSourcePrompts(selectedChannel),
        });
      } catch (error) {
        logger.warn('Failed to refresh source prompts:', error);
      }
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
    return `<@${userId}> chose violence and asked TLDR to roast these ${count} messages:`;
  }
  if (kind === 'receipts') {
    return `<@${userId}> asked TLDR to pull receipts from these ${count} messages:`;
  }
  return `<@${userId}> asked TLDR to summarize these ${count} messages:`;
}

type RerunArgs = SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs & {
  config: AppConfig;
  transformAction: SummaryTransformValue['action'];
  style: string | null;
  statusText: string;
};

/** Only bounded v2 actions may transform a saved result. Legacy buttons must refresh. */
export function parseSummaryTransformValue(raw: unknown): SummaryTransformValue | null {
  if (typeof raw !== 'string' || raw.length > 2000) {
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const value = parsed as Record<string, unknown>;
  const window = parseSummaryWindow(value.window);
  const styleKeys = ['default', 'custom', ...STYLE_PRESETS.map((preset) => preset.key)];
  if (value.v !== 2 || !['rerun_shorter', 'rerun_roast', 'rerun_receipts'].includes(String(value.action)) ||
    typeof value.channelId !== 'string' || !isValidSlackChannelId(value.channelId) ||
    typeof value.count !== 'number' || !Number.isInteger(value.count) || value.count < 1 || value.count > 500 ||
    !window || typeof value.styleKey !== 'string' || !styleKeys.includes(value.styleKey) ||
    typeof value.shorter !== 'boolean') {
    return null;
  }
  return {
    v: 2, action: value.action as SummaryTransformValue['action'], channelId: value.channelId,
    count: value.count, window, styleKey: value.styleKey as SummaryTransformValue['styleKey'], shorter: value.shorter,
  };
}

async function handleRerun(args: RerunArgs): Promise<void> {
  const { ack, body, action, client, logger, config, style, statusText } = args;
  await ack();
  const message = 'message' in body ? body.message : null;
  const channel = 'channel' in body ? body.channel : null;
  if (!message || !channel || action.type !== 'button') {
    return;
  }
  const reply = async (text: string): Promise<void> => {
    await client.chat.postMessage({ channel: channel.id, thread_ts: message.thread_ts ?? message.ts, text });
  };
  try {
    const value = parseSummaryTransformValue(action.value);
    if (!value || value.action !== args.transformAction) {
      await reply('This older or incomplete summary has no usable saved time window. Refresh the source, then use the controls on the new summary.');
      return;
    }
    let customStyle = style;
    let summaryToShorten: string | undefined;
    if (args.transformAction === 'rerun_shorter') {
      const visibleRecap = extractSummaryBody(message).trim();
      if (!isValidSummaryToShorten(visibleRecap)) {
        await reply("I couldn't use that summary's text. Refresh the source with a smaller message limit, then try Shorter again.");
        return;
      }
      summaryToShorten = visibleRecap;
      // The visible recap carries its existing tone. Arbitrary private
      // instructions must never be recovered from broadly exposed metadata.
      customStyle = value.styleKey === 'custom' || value.styleKey === 'default'
        ? null : resolveStylePreset(value.styleKey);
    }
    await guardAndRunSummarization({
      client, config, userId: body.user.id, sourceChannelId: value.channelId,
      assistantChannelId: channel.id, assistantThreadTs: message.thread_ts ?? message.ts,
      messageCount: value.count, customStyle, window: value.window,
      shorter: args.transformAction === 'rerun_shorter' || value.shorter,
      summaryToShorten,
      statusText, logger,
    });
  } catch (error) {
    logger.error('Failed to transform saved summary:', error);
    await reply("I couldn't recover that summary's saved settings. Refresh the source before trying again.");
  }
}
