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
  Button,
  ContextActionsBlock,
  ContextBlock,
  KnownBlock,
} from '@slack/types';
import { isReceiptsStyle, isRoastStyle } from '../styles';

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

interface RerunButtonValue {
  action: 'rerun_roast' | 'rerun_receipts';
  channelId: string;
  count: number;
}

export interface SummaryActionButtonsArgs {
  sourceChannelId: string;
  messageCount: number;
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
  const elements: Button[] = [];

  const shareValue: ShareButtonValue = {
    action: 'share_summary',
    sourceChannelId,
    count: messageCount,
    styleKind: toStyleKind(currentStyle),
  };
  elements.push({
    type: 'button',
    text: { type: 'plain_text', text: '📤 Share to channel', emoji: true },
    action_id: 'share_summary',
    value: JSON.stringify(shareValue),
    confirm: {
      title: { type: 'plain_text', text: 'Share this summary?' },
      text: {
        type: 'mrkdwn',
        text: `This posts the full summary to <#${sourceChannelId}> with your name on it.`,
      },
      confirm: { type: 'plain_text', text: 'Share it' },
      deny: { type: 'plain_text', text: 'Cancel' },
    },
  });

  if (!isRoastStyle(currentStyle)) {
    const value: RerunButtonValue = { action: 'rerun_roast', channelId: sourceChannelId, count: messageCount };
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: '🔥 Roast This', emoji: true },
      action_id: 'rerun_roast',
      value: JSON.stringify(value),
    });
  }
  if (!isReceiptsStyle(currentStyle)) {
    const value: RerunButtonValue = { action: 'rerun_receipts', channelId: sourceChannelId, count: messageCount };
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: '📜 Pull Receipts', emoji: true },
      action_id: 'rerun_receipts',
      value: JSON.stringify(value),
    });
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
          `🤖 AI-generated • last ${args.messageCount} messages from <#${args.sourceChannelId}>` +
          ` • <!date^${unixSeconds}^{time}|${fallback}>`,
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
