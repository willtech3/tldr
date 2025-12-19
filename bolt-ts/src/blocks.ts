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
          "👋 Hi! I'm TLDR. I can summarize the channel you're currently viewing.\n\n" +
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
          '*Commands:*\n' +
          '• `summarize` - Summarize the last 50 messages in the channel you’re viewing\n' +
          '• `summarize last N` - Summarize the last N messages (e.g., `summarize last 100`)\n' +
          '• `style: <instructions>` - Set a custom style for this assistant thread\n' +
          '• `help` - Show this help message',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Notes:*\n' +
          '• TLDR automatically tracks your current channel as you navigate Slack\n' +
          '• You can also mention a channel (e.g., `summarize <#C123|general>`) to override context',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Tips:*\n' +
          '• Summaries appear in this assistant thread\n' +
          '• Make styles specific (e.g., “funny, short, and include receipts”)',
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

