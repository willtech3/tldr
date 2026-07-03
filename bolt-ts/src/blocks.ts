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
import { DEFAULT_STYLE_PRESET_KEY, STYLE_PRESETS } from './styles';

type KnownBlock = types.KnownBlock;

export const ACTION_OPEN_STYLE_MODAL = 'open_style_modal';
export const ACTION_SELECT_MESSAGE_COUNT = 'select_message_count';
export const ACTION_QUICK_SUMMARIZE = 'quick_summarize';
export const ACTION_SHOW_HELP = 'show_help';
export const ACTION_RETRY_SUMMARY = 'retry_summary';
export const MODAL_CALLBACK_SET_STYLE = 'set_style_modal';
export const INPUT_BLOCK_STYLE = 'style_input_block';
export const INPUT_ACTION_STYLE = 'style_input_action';
export const INPUT_BLOCK_STYLE_PRESET = 'style_preset_block';
export const INPUT_ACTION_STYLE_PRESET = 'style_preset_action';

/** Value payload carried by the retry button under a failed summary. */
export interface RetrySummaryValue {
  channelId: string;
  count: number;
  /** Inlined style when short enough for Slack's 2,000-char button value cap. */
  style: string | null;
  /** When true the style was too long to inline — re-read it from thread state. */
  useThreadStyle?: boolean;
}

/** Longest style we inline in a button value (Slack caps values at 2,000 chars). */
const MAX_INLINE_BUTTON_STYLE_CHARS = 1_500;

/**
 * Build a retry payload that always fits Slack's button value limit. Long
 * styles aren't inlined; the retry handler falls back to the thread's saved
 * style instead.
 */
export function buildRetryValue(
  channelId: string,
  count: number,
  style: string | null
): RetrySummaryValue {
  if (style && style.length > MAX_INLINE_BUTTON_STYLE_CHARS) {
    return { channelId, count, style: null, useThreadStyle: true };
  }
  return { channelId, count, style };
}

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
          "👋 *Hi! I'm TLDR.* I turn busy channels into tight summaries — with links, receipts, and image highlights.\n\n" +
          'Hit *⚡ Summarize now*, pick a suggested prompt, or just talk to me (`catch me up`, `summarize last 200`, or any question — I chat too).',
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
        style: 'primary',
        text: { type: 'plain_text', text: '⚡ Summarize now', emoji: true },
        action_id: ACTION_QUICK_SUMMARIZE,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🎨 Set style', emoji: true },
        action_id: ACTION_OPEN_STYLE_MODAL,
      },
    ],
  });

  return blocks;
}

/**
 * Friendly fallback for messages that don't parse into a command. Always
 * gives the user a next step — never leave them on read.
 */
export function buildUnknownIntentBlocks(viewingChannelId?: string | null): KnownBlock[] {
  const target = viewingChannelId ? `<#${viewingChannelId}>` : "the channel you're viewing";
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `🤔 I didn't catch that — summarizing is my whole personality.\n` +
          `Want me to summarize ${target}?`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: '⚡ Summarize now', emoji: true },
          action_id: ACTION_QUICK_SUMMARIZE,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📖 Show me everything', emoji: true },
          action_id: ACTION_SHOW_HELP,
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '💡 You can also try `catch me up`, `summarize last 200`, or `style: write as a haiku`.',
        },
      ],
    },
  ];
}

/**
 * Failure message with a one-tap retry carrying the original request, so a
 * transient error never ends in a dead end. Pass `text` to override the
 * default apology (e.g. the bot-not-in-channel guidance).
 */
export function buildFailureBlocks(
  retry: RetrySummaryValue,
  text?: string,
  buttonLabel = '🔄 Try again'
): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          text ??
          `😅 That summary didn't come together — something hiccuped on my end.\nGive it another shot?`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: buttonLabel, emoji: true },
          action_id: ACTION_RETRY_SUMMARY,
          value: JSON.stringify(retry),
        },
      ],
    },
  ];
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
          '• `summarize` (or `catch me up`, `what did I miss`, `tldr`) — your default window.\n' +
          '• `summarize last 100` — explicit count.\n' +
          '• `summarize #general` — pick a different channel.\n' +
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
          '• Each summary comes with *📤 Share to channel*, *🔥 Roast This*, and *📜 Pull Receipts* buttons.\n' +
          '• Right-click any message → *Summarize Thread* for an instant, private thread recap.\n' +
          '• `@TLDR <question>` in any channel I\'m in gets a chat reply in that thread.\n' +
          '• Use the dropdown in the welcome message to change how many messages I read.\n' +
          '• Styles only apply to this thread — start a new one to reset.\n' +
          '• I can only summarize channels *you* are a member of.',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '💡 Tap *⚡ Summarize now* in the welcome card, or just type `summarize`.',
        },
      ],
    },
  ];
}

export interface StyleModalPrivateMetadata {
  assistantChannelId: string;
  assistantThreadTs: string;
  /**
   * The text the free-form input was prefilled with, so the submit handler
   * can tell "user left the prefill alone and picked a preset" apart from
   * "user typed their own style".
   */
  originalStyle?: string | null;
}

export function buildStyleModal(
  currentStyle: string | null,
  privateMetadata: StyleModalPrivateMetadata
): View {
  const matchingPreset = STYLE_PRESETS.find((preset) => preset.value === currentStyle);
  const prefillText = matchingPreset ? null : currentStyle ?? null;
  const metadata: StyleModalPrivateMetadata = {
    ...privateMetadata,
    originalStyle: prefillText,
  };
  const presetOptions = [
    {
      text: { type: 'plain_text' as const, text: '✨ Default — no special style', emoji: true },
      value: DEFAULT_STYLE_PRESET_KEY,
    },
    // Option `value` is the short preset key — Slack caps values at 150 chars,
    // so the full style text must never go here.
    ...STYLE_PRESETS.map((preset) => ({
      text: { type: 'plain_text' as const, text: preset.label, emoji: true },
      value: preset.key,
    })),
  ];
  return {
    type: 'modal',
    callback_id: MODAL_CALLBACK_SET_STYLE,
    private_metadata: JSON.stringify(metadata),
    title: { type: 'plain_text', text: 'Set Summary Style', emoji: true },
    submit: { type: 'plain_text', text: 'Save', emoji: true },
    close: { type: 'plain_text', text: 'Cancel', emoji: true },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            'Choose how TLDR writes summaries for this thread — pick a preset, or write your own instructions below.\n' +
            'Pick *✨ Default* (or clear both) to go back to the standard style.',
        },
      },
      {
        type: 'input',
        block_id: INPUT_BLOCK_STYLE_PRESET,
        optional: true,
        element: {
          type: 'static_select',
          action_id: INPUT_ACTION_STYLE_PRESET,
          placeholder: { type: 'plain_text', text: 'Pick a ready-made style…' },
          options: presetOptions,
          ...(matchingPreset
            ? {
                initial_option: {
                  text: { type: 'plain_text', text: matchingPreset.label, emoji: true },
                  value: matchingPreset.key,
                },
              }
            : {}),
        },
        label: { type: 'plain_text', text: 'Preset', emoji: true },
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
          initial_value: prefillText ?? undefined,
        },
        label: { type: 'plain_text', text: 'Or write your own', emoji: true },
        hint: {
          type: 'plain_text',
          text: 'Applied to every summary in this thread (up to 4,000 characters).',
        },
      },
    ],
  };
}

export function buildStyleConfirmationBlocks(style: string | null): KnownBlock[] {
  const tryItNow: KnownBlock = {
    type: 'actions',
    elements: [
      {
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: '⚡ Try it now', emoji: true },
        action_id: ACTION_QUICK_SUMMARIZE,
      },
    ],
  };

  if (!style) {
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '✅ Style cleared. Summaries will use the default style.' },
      },
      tryItNow,
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
    tryItNow,
  ];
}
