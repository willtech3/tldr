/** Explicit fresh-source requests exposed in each summary's native menu. */
import type { Overflow, PlainTextOption } from '@slack/types';
import { isValidSlackChannelId } from './security';
import { STYLE_PRESETS, summaryStyleLabel } from './styles';

export const ACTION_SUMMARY_LATEST = 'summary_latest';
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
  if (Object.keys(value).some((key) => !['v', 'action', 'channelId', 'count', 'styleKey'].includes(key)) ||
    value.v !== 1 || (value.action !== 'refresh_latest' && value.action !== 'expand_latest') ||
    typeof value.channelId !== 'string' || !isValidSlackChannelId(value.channelId) ||
    typeof value.count !== 'number' || !Number.isInteger(value.count) || value.count < 1 || value.count > 500 ||
    typeof value.styleKey !== 'string' || !PRESET_KEYS.some((key) => key === value.styleKey)) {
    return null;
  }
  return value as unknown as SummaryLatestValue;
}

export function buildSummaryLatestMenu(args: {
  sourceChannelId: string;
  sourceChannelName?: string;
  messageCount: number;
  currentStyle: string | null;
}): Overflow | null {
  const preset = STYLE_PRESETS.find((candidate) => candidate.value === args.currentStyle?.trim());
  // A fresh request cannot privately recover arbitrary one-off instructions.
  // Say Default explicitly instead of silently adopting mutable thread style.
  const styleKey = (preset?.key ?? 'default') as LatestStyleKey;
  const styleLabel = preset ? summaryStyleLabel(preset.value) : 'Default';
  const sourceLabel = args.sourceChannelName && args.sourceChannelName !== args.sourceChannelId
    ? `#${args.sourceChannelName}` : args.sourceChannelId;
  const description = `Latest messages in ${sourceLabel}`;
  const options: PlainTextOption[] = [];
  const addOption = (action: SummaryLatestValue['action'], count: number, label: string): boolean => {
    const value = JSON.stringify({ v: 1, action, channelId: args.sourceChannelId, count, styleKey });
    if (!parseSummaryLatestValue(value)) {
      return false;
    }
    options.push({
      text: { type: 'plain_text', text: `${label} ${count} · ${styleLabel}` },
      description: { type: 'plain_text', text: description.length > 75 ? `${description.slice(0, 72)}...` : description },
      value,
    });
    return true;
  };
  if (!addOption('refresh_latest', args.messageCount, 'Refresh latest')) {
    return null;
  }
  if (args.messageCount < 500) {
    const count = Math.min(500, Math.max(200, (Math.floor(args.messageCount / 100) + 1) * 100));
    addOption('expand_latest', count, 'Expand to latest');
  }
  // Slack's overflow trigger is the native ellipsis; custom labels are unsupported.
  return { type: 'overflow', action_id: ACTION_SUMMARY_LATEST, options };
}
