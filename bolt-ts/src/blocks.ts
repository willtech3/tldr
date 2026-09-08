/**
 * Block Kit builders for the TLDR assistant surface.
 *
 * UI design notes:
 *  - The welcome message doubles as the canonical thread-state message —
 *    metadata on it persists viewingChannelId / customStyle / defaultMessageCount.
 *  - The source stays beside the primary action; count and style are compact
 *    controls above it.
 *  - Slack's contextual status (suggested prompts, setStatus) is handled in
 *    the Assistant middleware, not in the welcome blocks.
 */

import { createHash } from 'node:crypto';
import { types } from '@slack/bolt';
import type { View } from '@slack/types';
import { normalizeMessageCount } from './security';
import { DEFAULT_STYLE_PRESET_KEY, STYLE_PRESETS } from './styles';
import type { SummaryWindow } from './types';

type KnownBlock = types.KnownBlock;

export const ACTION_OPEN_STYLE_MODAL = 'open_style_modal';
export const ACTION_SELECT_MESSAGE_COUNT = 'select_message_count';
export const ACTION_SELECT_SOURCE = 'select_source';
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
  /** Legacy payloads may inline a style; new buttons only carry preset keys. */
  style?: string | null;
  styleKey?: string;
  /** Legacy retries may request the saved thread style. */
  useThreadStyle?: boolean;
  /** Custom-style retries must return to the original request or summary. */
  requiresOriginal?: boolean;
  window?: SummaryWindow;
  shorter?: boolean;
}

/**
 * Keep retry buttons compact and free of arbitrary style instructions. A
 * custom-style request cannot recover its exact style from mutable thread
 * defaults, so failure copy points back to the original request or summary.
 */
export function buildRetryValue(
  channelId: string,
  count: number,
  style: string | null,
  options: { window?: SummaryWindow; shorter?: boolean; requiresOriginal?: boolean } = {}
): RetrySummaryValue {
  const retry: RetrySummaryValue = {
    channelId,
    count,
    ...(options.window !== undefined ? { window: options.window } : {}),
    ...(options.shorter !== undefined ? { shorter: options.shorter } : {}),
  };
  if (options.requiresOriginal) {
    return { ...retry, requiresOriginal: true };
  }
  const trimmedStyle = style?.trim();
  const preset = STYLE_PRESETS.find((candidate) => candidate.value === trimmedStyle);
  if (!trimmedStyle || preset) {
    return { ...retry, styleKey: preset?.key ?? DEFAULT_STYLE_PRESET_KEY };
  }
  return { ...retry, requiresOriginal: true };
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
  const sourceText = viewingChannelId ? `<#${viewingChannelId}>` : 'Choose a channel';
  const styleLabel = activeStyle
    ? STYLE_PRESETS.find((preset) => preset.value === activeStyle)?.label.split(' — ')[0] ?? 'Custom'
    : 'Default';
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: 'Catch up on the conversation.' },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Source:* ${sourceText}` },
      accessory: {
        type: 'conversations_select',
        action_id: ACTION_SELECT_SOURCE,
        placeholder: { type: 'plain_text', text: 'Choose source channel' },
        ...(viewingChannelId ? { initial_conversation: viewingChannelId } : {}),
        filter: { include: ['public', 'private'] },
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Message limit*' },
      accessory: {
        type: 'static_select',
        action_id: ACTION_SELECT_MESSAGE_COUNT,
        initial_option: {
          text: { type: 'plain_text', text: `${effectiveCount} messages` },
          value: String(effectiveCount),
        },
        options: MESSAGE_COUNT_OPTIONS.map((count) => ({
          text: { type: 'plain_text', text: `${count} messages` },
          value: String(count),
        })),
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Style: *${styleLabel}* · Source and style stay set for this thread.` }],
    },
    ...(viewingChannelId ? [{
      type: 'section' as const,
      text: { type: 'mrkdwn' as const, text: `Catch up on ${sourceText}` },
      accessory: {
        type: 'button' as const,
        style: 'primary' as const,
        text: { type: 'plain_text' as const, text: 'Catch up' },
        accessibility_label: 'Catch up on the selected source channel',
        action_id: ACTION_QUICK_SUMMARIZE,
      },
    }] : []),
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Set style' },
        action_id: ACTION_OPEN_STYLE_MODAL,
      }],
    },
  ];
}

/** Shown (and used as the visible section) when a general-chat reply fails. */
export const CHAT_FAILURE_TEXT =
  "😅 I couldn't come up with a reply just now — try again, or ask for a summary.";

/**
 * Failure card for a general-chat miss. Slack renders `blocks` instead of
 * top-level `text`, so this section must match {@link CHAT_FAILURE_TEXT} —
 * not the old "I didn't catch that" copy, which blamed the user's phrasing
 * for a model/transport failure.
 */
export function buildChatFailureBlocks(viewingChannelId?: string | null): KnownBlock[] {
  const target = viewingChannelId ? `<#${viewingChannelId}>` : 'your selected source';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${CHAT_FAILURE_TEXT}\nWant me to summarize ${target} instead?`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Catch up' },
          action_id: ACTION_QUICK_SUMMARIZE,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Help' },
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
  const failureText = text ?? "That summary didn't come together. Please try again.";
  if (retry.requiresOriginal) {
    const recovery = retry.window
      ? 'Use the action on the original summary to retry with its saved style and time window.'
      : 'Repeat your original request to retry with the same custom style.';
    return [{ type: 'section', text: { type: 'mrkdwn', text: `${failureText}\n${recovery}` } }];
  }
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: failureText },
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

/** Concise guidance for the controls and their source-window behavior. */
export function buildHelpBlocks(): KnownBlock[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Using TLDR' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Catch up*\n' +
          'Choose a *Source* channel and *Message limit* above, then click *Catch up*. ' +
          'Or type `summarize`, `summarize last 100`, or `summarize #channel`. ' +
          'Your selected source stays set for this thread.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Work with a summary*\n' +
          '*Shorter*, *Roast*, and *Receipts* use that summary’s source and date window; ' +
          'message edits and deletions may still change the result. ' +
          'The *⋯ menu* offers *Refresh latest* and *Expand to latest* for new messages at the stated count and style. ' +
          '*Share to #channel* shows a confirmation with the destination before posting.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Set your style*\n' +
          'Click *Set style* or type `style: write as a haiku`. It applies to this thread. ' +
          'Choose *Default* in the style menu or type `clear style` to reset. ' +
          'Use `summarize with style: be brief` for a one-time change.',
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: 'You can also ask a question here, or right-click a message → *Summarize Thread*. ' +
          'TLDR can only summarize channels you belong to.',
      }],
    },
  ];
}

export interface StyleModalPrivateMetadata {
  assistantChannelId: string;
  assistantThreadTs: string;
  /** Detect untouched prefill without exceeding Slack's 3,000-character metadata limit. */
  originalStyleDigest?: string;
  /** A legacy text-command style cannot fit in Slack's modal editor. */
  hasLongSavedStyle?: boolean;
}

/** Slack's plain_text_input max_length accepts at most 3,000 characters. */
export const MAX_MODAL_STYLE_LENGTH = 3000;

export function stylePrefillDigest(style: string): string {
  return createHash('sha256').update(style.trim()).digest('hex');
}

export function buildStyleModal(
  currentStyle: string | null,
  privateMetadata: StyleModalPrivateMetadata
): View {
  const matchingPreset = STYLE_PRESETS.find((preset) => preset.value === currentStyle);
  const hasLongSavedStyle = (currentStyle?.length ?? 0) > MAX_MODAL_STYLE_LENGTH;
  const prefillText = matchingPreset || hasLongSavedStyle ? null : currentStyle ?? null;
  const metadata: StyleModalPrivateMetadata = {
    assistantChannelId: privateMetadata.assistantChannelId,
    assistantThreadTs: privateMetadata.assistantThreadTs,
    ...(prefillText ? { originalStyleDigest: stylePrefillDigest(prefillText) } : {}),
    ...(hasLongSavedStyle ? { hasLongSavedStyle: true } : {}),
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
            'Set the style for summaries in this thread. Choose a preset or write your own.\n' +
            'Choose *Default* to reset.' +
            (hasLongSavedStyle
              ? '\nYour saved style is longer than this editor allows. It stays active until you choose a preset or enter a replacement. Use `style: …` in chat to edit up to 4,000 characters.'
              : ''),
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
          max_length: MAX_MODAL_STYLE_LENGTH,
          placeholder: {
            type: 'plain_text',
            text: 'e.g., "Write as a haiku" or "Be extremely concise and funny"',
          },
          initial_value: prefillText ?? undefined,
        },
        label: { type: 'plain_text', text: 'Or write your own', emoji: true },
        hint: {
          type: 'plain_text',
          text: 'Up to 3,000 characters. New text takes priority over the preset.',
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
        text: { type: 'mrkdwn', text: '✅ Default style saved for this thread.' },
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
        { type: 'mrkdwn', text: `🎨 Active style: ${STYLE_PRESETS.find((preset) => preset.value === style)?.label ?? 'Custom'}` },
      ],
    },
    tryItNow,
  ];
}
