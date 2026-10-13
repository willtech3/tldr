/** Explicit fresh-source requests exposed in each summary's native menu. */
import type { Overflow, PlainTextOption } from '@slack/types';
import { isValidSlackChannelId } from './security';
import { STYLE_PRESETS, summaryStyleLabel } from './styles';

export const ACTION_SUMMARY_LATEST = 'summary_latest';
/** Labeled fresh-read button. The overflow menu only offers a wider window. */
export const ACTION_WHATS_NEW = 'summary_whats_new';
const MAX_OPTION_VALUE_LENGTH = 150;
const PRESET_KEYS = ['default', 'roast', 'receipts', 'exec_brief', 'haiku'] as const;
type LatestStyleKey = typeof PRESET_KEYS[number];

export interface SummaryLatestValue {
  v: 1;
  action: 'refresh_latest' | 'expand_latest';
  channelId: string;
  count: number;
  styleKey: LatestStyleKey;
}

/** Reject unknown fields, including saved windows or private custom instructions. */
export function parseSummaryLatestValue(raw: unknown): SummaryLatestValue | null {
  if (typeof raw !== 'string' || raw.length > MAX_OPTION_VALUE_LENGTH) {
    return null;
  }
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    value = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (Object.keys(value).some((key) => !['v', 'action', 'channelId', 'count', 'styleKey', 'e'].includes(key)) ||
    value.v !== 1 || (value.action !== 'refresh_latest' && value.action !== 'expand_latest') ||
    typeof value.channelId !== 'string' || !isValidSlackChannelId(value.channelId) ||
    typeof value.count !== 'number' || !Number.isInteger(value.count) || value.count < 1 || value.count > 500 ||
    typeof value.styleKey !== 'string' || !PRESET_KEYS.some((key) => key === value.styleKey) ||
    ('e' in value && value.e !== 1)) {
    return null;
  }
  return {
    v: 1,
    action: value.action as SummaryLatestValue['action'],
    channelId: value.channelId,
    count: value.count as number,
    styleKey: value.styleKey as LatestStyleKey,
  };
}

export interface SummaryLatestMenuArgs {
  sourceChannelId: string;
  sourceChannelName?: string;
  messageCount: number;
  currentStyle: string | null;
  /** Ask follow-up clicks to stay ephemeral even if Slack omits container.is_ephemeral. */
  privateReply?: boolean;
}

/**
 * Serialized fresh-read payload. Null when the value would not survive
 * {@link parseSummaryLatestValue} (bad id, count, or over 150 characters).
 * Custom instructions are never copied in; unknown styles become Default.
 */
export function buildSummaryLatestValue(
  args: Pick<SummaryLatestMenuArgs, 'sourceChannelId' | 'currentStyle' | 'privateReply'>,
  action: SummaryLatestValue['action'],
  count: number,
): string | null {
  const preset = STYLE_PRESETS.find((candidate) => candidate.value === args.currentStyle?.trim());
  const styleKey = (preset?.key ?? 'default') as LatestStyleKey;
  const value = JSON.stringify({
    v: 1, action, channelId: args.sourceChannelId, count, styleKey,
    ...(args.privateReply ? { e: 1 } : {}),
  });
  return parseSummaryLatestValue(value) ? value : null;
}

/** How many messages a wider window asks for. Stays above the current count and at most 500. */
export function expandLatestCount(messageCount: number): number {
  return Math.min(500, Math.max(200, (Math.floor(messageCount / 100) + 1) * 100));
}

export function buildSummaryLatestMenu(args: SummaryLatestMenuArgs): Overflow | null {
  if (!Number.isInteger(args.messageCount) || args.messageCount < 1 || args.messageCount >= 500) {
    return null;
  }
  const count = expandLatestCount(args.messageCount);
  const value = buildSummaryLatestValue(args, 'expand_latest', count);
  if (!value) {
    return null;
  }
  const preset = STYLE_PRESETS.find((candidate) => candidate.value === args.currentStyle?.trim());
  const styleLabel = preset ? summaryStyleLabel(preset.value) ?? 'Default' : 'Default';
  const sourceLabel = args.sourceChannelName && args.sourceChannelName !== args.sourceChannelId
    ? `#${args.sourceChannelName}` : args.sourceChannelId;
  const description = `Latest messages in ${sourceLabel}`;
  const option: PlainTextOption = {
    text: { type: 'plain_text', text: `Go back further ${count} · ${styleLabel}` },
    description: { type: 'plain_text', text: description.length > 75 ? `${description.slice(0, 72)}...` : description },
    value,
  };
  // Slack's overflow trigger is the native ellipsis; the repeat read is a labeled button.
  return { type: 'overflow', action_id: ACTION_SUMMARY_LATEST, options: [option] };
}
