/**
 * Block Kit builders for Slack UI components.
 *
 * These functions generate Block Kit JSON for various UI elements.
 */

import { types } from '@slack/bolt';

type KnownBlock = types.KnownBlock;

/**
 * Build welcome message blocks shown when assistant thread starts.
 */
export function buildWelcomeBlocks(): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          "👋 Hi! I'm TLDR Bot. I can summarize channel messages for you.\n\n" +
          '*Quick start:*\n' +
          '• Click a suggested prompt below\n' +
          '• Or type `help` to see all commands\n' +
          '• Just type `summarize` to get started',
      },
    },
  ];
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
          '*Basic Commands:*\n' +
          '• `summarize` - Summarize recent messages from a channel\n' +
          '• `summarize last 50` - Summarize the last 50 messages\n' +
          '• `help` - Show this help message',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Advanced Features:*\n' +
          '• `customize` or `configure` - Set custom prompt styles for a channel\n' +
          '• Mention a channel (e.g., `summarize #general`) to target specific channels',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Tips:*\n' +
          "• The bot will ask you to select a channel if you don't mention one\n" +
          '• Summaries are sent as DMs by default\n' +
          '• Add custom style prompts for creative summaries (poems, haikus, etc.)',
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
 * Build channel picker blocks for configure flow.
 */
export function buildConfigurePickerBlocks(): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Pick a conversation to configure TLDR for:',
      },
    },
    {
      type: 'actions',
      block_id: 'tldr_pick_config',
      elements: [
        {
          type: 'conversations_select',
          action_id: 'tldr_pick_conv',
          default_to_current_conversation: true,
          response_url_enabled: true,
        },
      ],
    },
  ];
}

/**
 * Build channel picker blocks for summarize flow.
 *
 * @param blockId - Unique block ID for the picker
 * @param promptText - Text to display above the picker
 */
export function buildChannelPickerBlocks(blockId: string, promptText: string): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: promptText,
      },
    },
    {
      type: 'actions',
      block_id: blockId,
      elements: [
        {
          type: 'conversations_select',
          action_id: 'tldr_pick_conv',
          default_to_current_conversation: true,
        },
      ],
    },
  ];
}
