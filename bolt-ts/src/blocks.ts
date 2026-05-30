/**
 * Block Kit builders for the TLDR assistant surface.
 *
 * UI design notes:
 *  - The welcome message doubles as the canonical thread-state message —
 *    metadata on it persists viewingChannelId / customStyle / defaultMessageCount.
 *  - Dropdown and the "Set style" button are the primary controls, so they
 *    sit immediately under the intro with a divider above them.
 *  - Slack's contextual status (suggested prompts, setStatus) is handled in
 *    the Assistant middleware, not in the welcome blocks.
 */

import { types } from '@slack/bolt';
import type { View } from '@slack/types';
import { normalizeMessageCount } from './security';

type KnownBlock = types.KnownBlock;

export const ACTION_OPEN_STYLE_MODAL = 'open_style_modal';
export const ACTION_SELECT_MESSAGE_COUNT = 'select_message_count';
export const MODAL_CALLBACK_SET_STYLE = 'set_style_modal';
export const INPUT_BLOCK_STYLE = 'style_input_block';
export const INPUT_ACTION_STYLE = 'style_input_action';

export const MESSAGE_COUNT_OPTIONS = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 500];

/**
 * Welcome blocks shown at the top of every assistant thread. Doubles as the
 * canonical thread-state message — its metadata persists viewingChannelId /
 * customStyle / defaultMessageCount across cold starts.
 */
export function buildWelcomeBlocks(
  viewingChannelId?: string | null,
  activeStyle?: string | null,
  defaultMessageCount?: number | null
): KnownBlock[] {
  const effectiveCount = normalizeMessageCount(defaultMessageCount);
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          "👋 *Hi! I'm TLDR.* I summarize the channel you're currently viewing.\n\n" +
          'Pick a suggested prompt below, type `summarize`, or `help` for the full command list.',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '📊 *How many messages to summarize?*',
      },
      accessory: {
        type: 'static_select',
        action_id: ACTION_SELECT_MESSAGE_COUNT,
        initial_option: {
          text: { type: 'plain_text', text: String(effectiveCount) },
          value: String(effectiveCount),
        },
        options: MESSAGE_COUNT_OPTIONS.map((count) => ({
          text: { type: 'plain_text', text: String(count) },
          value: String(count),
        })),
      },
    },
  ];

  if (viewingChannelId) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `📍 *Viewing:* <#${viewingChannelId}>`,
        },
      ],
    });
  } else {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '📍 _Open a channel in Slack to enable one-tap summaries._',
        },
      ],
    });
  }

  if (activeStyle) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `🎨 *Active style:* ${truncateStyle(activeStyle)}`,
        },
      ],
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '🎨 Set style', emoji: true },
        action_id: ACTION_OPEN_STYLE_MODAL,
      },
    ],
  });

  return blocks;
}

function truncateStyle(style: string): string {
  // Count by Unicode code points so we never split an emoji / surrogate pair.
  const chars = [...style];
  if (chars.length <= 100) {
    return style;
  }
  return chars.slice(0, 97).join('') + '...';
}

/** Help blocks shown when the user types `help` / `?` / "what can you do". */
export function buildHelpBlocks(): KnownBlock[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'TLDR — Command Reference', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*🧾 Summarize the channel you\'re viewing*\n' +
          '• `summarize` — last 50 messages (or your chosen default).\n' +
          '• `summarize last 100` — explicit count.\n' +
          '• `summarize <#C123|general>` — pick a different channel.\n' +
          '• `summarize with style: write as a haiku` — one-off style override.',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*🎨 Persistent style for this thread*\n' +
          '• Click *🎨 Set style* in the welcome message for a multi-line editor.\n' +
          '• Or type `style: be hyper-critical and roast everyone`.\n' +
          '• `clear style` to remove it.',
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*⚡ Tips*\n' +
          '• Each summary comes with *Share*, *Roast*, and *Receipts* buttons.\n' +
          '• Styles only apply to this thread — start a new one to reset.\n' +
          '• I can only summarize channels *you* are a member of.',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '💡 Try one of the suggested prompts above, or just type `summarize`.',
        },
      ],
    },
  ];
}

export interface StyleModalPrivateMetadata {
  assistantChannelId: string;
  assistantThreadTs: string;
}

export function buildStyleModal(
  currentStyle: string | null,
  privateMetadata: StyleModalPrivateMetadata
): View {
  return {
    type: 'modal',
    callback_id: MODAL_CALLBACK_SET_STYLE,
    private_metadata: JSON.stringify(privateMetadata),
    title: { type: 'plain_text', text: 'Set Summary Style', emoji: true },
    submit: { type: 'plain_text', text: 'Save', emoji: true },
    close: { type: 'plain_text', text: 'Cancel', emoji: true },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            'Customize how TLDR writes summaries for this thread.\n' +
            'Examples: _Write as a haiku_, _Be extremely concise_, _Roast everyone mercilessly_.\n' +
            'Leave empty to use the default style.',
        },
      },
      {
        type: 'input',
        block_id: INPUT_BLOCK_STYLE,
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: INPUT_ACTION_STYLE,
          multiline: true,
          max_length: 4000,
          placeholder: {
            type: 'plain_text',
            text: 'e.g., "Write as a haiku" or "Be extremely concise and funny"',
          },
          initial_value: currentStyle ?? undefined,
        },
        label: { type: 'plain_text', text: 'Custom Style Instructions', emoji: true },
        hint: {
          type: 'plain_text',
          text: 'Applied to every summary in this thread (up to 4 000 chars).',
        },
      },
    ],
  };
}

export function buildStyleConfirmationBlocks(style: string | null): KnownBlock[] {
  if (!style) {
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '✅ Style cleared. Summaries will use the default style.' },
      },
    ];
  }

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '✅ *Style saved for this thread.*' },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `🎨 Active style: ${truncateStyle(style)}` },
      ],
    },
  ];
}
