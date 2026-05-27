/**
 * Block Kit action button factory shared between non-streaming delivery and the
 * streaming finaliser. Renders the Share / Roast / Receipts buttons that
 * appear under every summary in the assistant thread.
 */

import type { ActionsBlock, Button, KnownBlock } from '@slack/types';

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

export interface SummaryActionButtonsArgs {
  sourceChannelId: string;
  messageCount: number;
  /** The style applied to the summary, if any. Drives which rerun buttons render. */
  currentStyle: string | null;
}

/**
 * Build an `actions` block containing Share / Roast / Receipts buttons.
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
    style: currentStyle,
  };
  elements.push({
    type: 'button',
    text: { type: 'plain_text', text: '📤 Share to channel', emoji: true },
    action_id: 'share_summary',
    value: JSON.stringify(shareValue),
  });

  const styleLower = currentStyle?.toLowerCase() ?? '';
  const isRoast = styleLower.includes('roast');
  const isReceipts = styleLower.includes('receipt');

  if (!isRoast) {
    const value: RerunButtonValue = { action: 'rerun_roast', channelId: sourceChannelId, count: messageCount };
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: '🔥 Roast This', emoji: true },
      action_id: 'rerun_roast',
      value: JSON.stringify(value),
    });
  }
  if (!isReceipts) {
    const value: RerunButtonValue = { action: 'rerun_receipts', channelId: sourceChannelId, count: messageCount };
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: '📜 Pull Receipts', emoji: true },
      action_id: 'rerun_receipts',
      value: JSON.stringify(value),
    });
  }

  const block: ActionsBlock = { type: 'actions', elements };
  return [block];
}
