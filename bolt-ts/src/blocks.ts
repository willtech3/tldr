/**
 * Block Kit builders for Slack UI components.
 *
 * These functions generate Block Kit JSON for various UI elements.
 */

import { types } from '@slack/bolt';
import type { View } from '@slack/types';

type KnownBlock = types.KnownBlock;

// Action IDs for interactive components
export const ACTION_OPEN_STYLE_MODAL = 'open_style_modal';
export const MODAL_CALLBACK_SET_STYLE = 'set_style_modal';
export const INPUT_BLOCK_STYLE = 'style_input_block';
export const INPUT_ACTION_STYLE = 'style_input_action';

/**
 * Build welcome message blocks shown when assistant thread starts.
 *
 * @param activeStyle - Optional active style to display
 */
export function buildWelcomeBlocks(activeStyle?: string | null): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          "👋 Hi! I'm TLDR. I can summarize the channel you're currently viewing.\n\n" +
          '*Quick start:*\n' +
          '• Click a suggested prompt below\n' +
          '• Or type `help` to see all commands\n' +
          '• Just type `summarize` to get started',
      },
    },
  ];

  // Show active style if set
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

  // Add "Set style" button
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: '🎨 Set style',
          emoji: true,
        },
        action_id: ACTION_OPEN_STYLE_MODAL,
      },
    ],
  });

  return blocks;
}

/**
 * Truncate style text for display (max 100 chars).
 */
function truncateStyle(style: string): string {
  if (style.length <= 100) {
    return style;
  }
  return style.substring(0, 97) + '...';
}

/**
 * Build help message blocks.
 */
export function buildHelpBlocks(): KnownBlock[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'TLDR Bot Commands', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Summarize:*\n' +
          "• `summarize` - Summarize the last 50 messages in the channel you're viewing\n" +
          '• `summarize last N` - Summarize the last N messages (e.g., `summarize last 100`)\n' +
          "• `summarize with style: <instructions>` - One-time style override (doesn't persist)",
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Style:*\n' +
          '• Click the "🎨 Set style" button to open the style editor\n' +
          '• `style: <instructions>` - Set a custom style for this assistant thread\n' +
          '• `clear style` - Remove the current style',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Notes:*\n' +
          '• TLDR automatically tracks your current channel as you navigate Slack\n' +
          '• You can also mention a channel (e.g., `summarize <#C123|general>`) to override context\n' +
          '• Styles persist for this thread only — each new thread starts fresh',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Tips:*\n' +
          '• Summaries appear in this assistant thread\n' +
          '• Make styles specific (e.g., "funny, short, and include receipts")\n' +
          '• Use per-run override for one-off style requests',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Try one of the suggested prompts below or type your own command!',
        },
      ],
    },
  ];
}

/**
 * Private data passed through modal submission.
 * Stored in the modal's private_metadata field as JSON.
 */
export interface StyleModalPrivateMetadata {
  assistantChannelId: string;
  assistantThreadTs: string;
}

/**
 * Build the "Set style" modal view.
 *
 * @param currentStyle - The current style (if any) to pre-fill
 * @param privateMetadata - Data to pass through to submission handler
 */
export function buildStyleModal(
  currentStyle: string | null,
  privateMetadata: StyleModalPrivateMetadata
): View {
  return {
    type: 'modal',
    callback_id: MODAL_CALLBACK_SET_STYLE,
    private_metadata: JSON.stringify(privateMetadata),
    title: {
      type: 'plain_text',
      text: 'Set Summary Style',
      emoji: true,
    },
    submit: {
      type: 'plain_text',
      text: 'Save',
      emoji: true,
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
      emoji: true,
    },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Customize how TLDR writes summaries for this thread. Leave empty to use the default style.',
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
          max_length: 800,
          placeholder: {
            type: 'plain_text',
            text: 'e.g., "Write as a haiku" or "Be extremely concise and funny"',
          },
          initial_value: currentStyle ?? undefined,
        },
        label: {
          type: 'plain_text',
          text: 'Custom Style Instructions',
          emoji: true,
        },
        hint: {
          type: 'plain_text',
          text: 'This style will apply to all summaries in this thread.',
        },
      },
    ],
  };
}

/**
 * Build style confirmation blocks shown after style is saved.
 *
 * @param style - The style that was saved (null if cleared)
 */
export function buildStyleConfirmationBlocks(style: string | null): KnownBlock[] {
  if (!style) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '✅ Style cleared. Summaries will use the default style.',
        },
      },
    ];
  }

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '✅ *Style saved for this thread.*',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `🎨 Active style: ${truncateStyle(style)}`,
        },
      ],
    },
  ];
}

