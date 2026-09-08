/**
 * Block Kit footer factory shared between non-streaming delivery and the
 * streaming finaliser. Renders, under every summary:
 *  - the Share / Roast / Receipts action buttons (Share gets a native
 *    confirmation dialog — it posts publicly),
 *  - a provenance context line (AI disclosure, scope, local-time stamp),
 *  - thumbs up/down feedback buttons (context_actions block).
 */

import type {
  ActionsBlock,
  ContextActionsBlock,
  ContextBlock,
  KnownBlock,
  MessageMetadata,
} from '@slack/types';
import { isReceiptsStyle, isRoastStyle, STYLE_PRESETS } from '../styles';
import type { SummaryCoverage, SummaryWindow } from '../types';
import { parseSummaryWindow } from '../summary_window';
import { buildSummaryLatestMenu } from '../summary_latest';

export const ACTION_SUMMARY_FEEDBACK = 'summary_feedback';

/** Compact style descriptor — full style text would blow Slack's 2,000-char button value cap. */
export type StyleKind = 'roast' | 'receipts' | 'default';

export function toStyleKind(style: string | null): StyleKind {
  if (isRoastStyle(style)) {
    return 'roast';
  }
  if (isReceiptsStyle(style)) {
    return 'receipts';
  }
  return 'default';
}

interface ShareButtonValue {
  action: 'share_summary';
  sourceChannelId: string;
  count: number;
  styleKind: StyleKind;
}

export type SummaryStyleKey = 'default' | 'custom' | 'roast' | 'receipts' | 'exec_brief' | 'haiku';

export interface SummaryTransformValue {
  v: 2;
  action: 'rerun_roast' | 'rerun_receipts' | 'rerun_shorter';
  channelId: string;
  count: number;
  window: SummaryWindow;
  styleKey: SummaryStyleKey;
  shorter: boolean;
}

export function toSummaryStyleKey(style: string | null): SummaryStyleKey {
  if (!style?.trim()) {
    return 'default';
  }
  return (STYLE_PRESETS.find((preset) => preset.value === style.trim())?.key as SummaryStyleKey | undefined) ?? 'custom';
}

export interface SummaryActionButtonsArgs {
  sourceChannelId: string;
  messageCount: number;
  /** Actual included count and dates; requested count stays available for refresh. */
  coverage?: SummaryCoverage;
  /** Original time window; preserve it even if messages were edited or removed. */
  window?: SummaryWindow;
  shorter?: boolean;
  sourceChannelName?: string;
  /** The style applied to the summary, if any. Drives which rerun buttons render. */
  currentStyle: string | null;
  /** Delivery timestamp (ms). Injectable for tests; defaults to now. */
  deliveredAtMs?: number;
}

/**
 * Build the full footer: action buttons, provenance line, feedback buttons.
 * Roast and Receipts buttons are hidden when the current summary already uses
 * that style — keeps the row clean for the user.
 */
export function buildSummaryActionButtons(args: SummaryActionButtonsArgs): KnownBlock[] {
  const { sourceChannelId, messageCount, currentStyle } = args;
  const elements: ActionsBlock['elements'] = [];
  const window = args.window ?? parseSummaryWindow(args.coverage);
  const sourceLabel = args.sourceChannelName && args.sourceChannelName !== sourceChannelId
    ? `#${args.sourceChannelName}` : sourceChannelId;

  const addTransform = (action: SummaryTransformValue['action'], label: string): void => {
    if (!window) {
      return;
    }
    const value: SummaryTransformValue = {
      v: 2, action, channelId: sourceChannelId, count: messageCount, window,
      styleKey: toSummaryStyleKey(currentStyle), shorter: args.shorter === true,
    };
    elements.push({
      type: 'button', text: { type: 'plain_text', text: label }, action_id: action,
      accessibility_label: `${label} using the same channel and time window`,
      value: JSON.stringify(value),
    });
  };
  if (!args.shorter) {
    addTransform('rerun_shorter', 'Shorter');
  }
  if (!isRoastStyle(currentStyle)) {
    addTransform('rerun_roast', 'Roast');
  }
  if (!isReceiptsStyle(currentStyle)) {
    addTransform('rerun_receipts', 'Receipts');
  }

  const shareValue: ShareButtonValue = {
    action: 'share_summary', sourceChannelId,
    count: args.coverage?.messageCount ?? messageCount, styleKind: toStyleKind(currentStyle),
  };
  const shareLabel = `Share to ${sourceLabel}`;
  elements.push({
    type: 'button',
    text: { type: 'plain_text', text: shareLabel.length > 75 ? shareLabel.slice(0, 72) + '...' : shareLabel },
    accessibility_label: 'Share this summary to its source channel',
    action_id: 'share_summary', value: JSON.stringify(shareValue),
    confirm: {
      title: { type: 'plain_text', text: 'Share this summary?' },
      text: { type: 'mrkdwn', text: `This posts the full summary to <#${sourceChannelId}> with your name on it.` },
      confirm: { type: 'plain_text', text: 'Share' }, deny: { type: 'plain_text', text: 'Cancel' },
    },
  });

  const latestMenu = buildSummaryLatestMenu(args);
  if (latestMenu) {
    elements.push(latestMenu);
  }

  const actions: ActionsBlock = { type: 'actions', elements };
  return [actions, buildProvenanceBlock(args), buildFeedbackBlock(args)];
}

/** Small grey footer: AI disclosure + scope + local-time stamp. */
function buildProvenanceBlock(args: SummaryActionButtonsArgs): ContextBlock {
  const deliveredAt = args.deliveredAtMs ?? Date.now();
  const unixSeconds = Math.floor(deliveredAt / 1000);
  const fallback = `${new Date(deliveredAt).toISOString().slice(11, 16)} UTC`;
  return {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text:
          `🤖 AI-generated • <#${args.sourceChannelId}>` +
          ` • <!date^${unixSeconds}^{time}|${fallback}> • ⋯ Get latest`,
      },
    ],
  };
}

/** Native thumbs up / down rating row. */
function buildFeedbackBlock(args: SummaryActionButtonsArgs): ContextActionsBlock {
  const feedbackContext = JSON.stringify({
    channelId: args.sourceChannelId,
    count: args.messageCount,
    roast: isRoastStyle(args.currentStyle),
    receipts: isReceiptsStyle(args.currentStyle),
  });
  return {
    type: 'context_actions',
    elements: [
      {
        type: 'feedback_buttons',
        action_id: ACTION_SUMMARY_FEEDBACK,
        positive_button: {
          text: { type: 'plain_text', text: 'Good summary' },
          accessibility_label: 'Rate this summary as good',
          value: `up:${feedbackContext}`,
        },
        negative_button: {
          text: { type: 'plain_text', text: 'Off the mark' },
          accessibility_label: 'Rate this summary as off the mark',
          value: `down:${feedbackContext}`,
        },
      },
    ],
  };
}

/** Shared provenance metadata for streaming and non-streaming results. */
export function buildSummaryMetadata(args: SummaryActionButtonsArgs): MessageMetadata {
  const window = args.window ?? parseSummaryWindow(args.coverage);
  const styleKey = toSummaryStyleKey(args.currentStyle);
  return {
    event_type: 'tldr_summary_v1',
    event_payload: {
      source_channel_id: args.sourceChannelId,
      message_count: args.coverage?.messageCount ?? args.messageCount,
      requested_message_count: args.messageCount,
      has_style: Boolean(args.currentStyle?.trim()),
      style_key: styleKey,
      shorter: args.shorter === true,
      ...(window ? { window: { ...window } } : {}),
      ...(args.coverage?.oldestTs ? { oldest_ts: args.coverage.oldestTs } : {}),
      ...(args.coverage?.latestTs ? { latest_ts: args.coverage.latestTs } : {}),
    },
  };
}

/** Standard Markdown coverage line; Slack date tokens cannot render in streams. */
export function buildCoverageText(coverage: SummaryCoverage): string {
  const count = `${coverage.messageCount} message${coverage.messageCount === 1 ? '' : 's'}`;
  if (!coverage.oldestTs || !coverage.latestTs) {
    return count;
  }
  const oldest = new Date(Number(coverage.oldestTs) * 1000);
  const latest = new Date(Number(coverage.latestTs) * 1000);
  const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const firstDate = dateFormat.format(oldest);
  const lastDate = dateFormat.format(latest);
  const firstTime = timeFormat.format(oldest);
  const lastTime = timeFormat.format(latest);
  const span = firstDate === lastDate
    ? `${firstDate} · ${firstTime}${firstTime === lastTime ? '' : `–${lastTime}`}`
    : `${firstDate}, ${firstTime} – ${lastDate}, ${lastTime}`;
  return `${count} · ${span} UTC`;
}
