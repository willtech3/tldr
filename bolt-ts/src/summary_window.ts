import type { SummaryWindow } from './types';

/** Bounded Slack decimal timestamp. Preserve the string so microseconds stay exact. */
function isSlackTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && /^\d{1,12}\.\d{1,6}$/.test(value) &&
    Number.isFinite(Number(value)) && Number(value) >= 0;
}

function timestampMicros(value: string): bigint {
  const [seconds, fraction] = value.split('.');
  return BigInt(seconds) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

/**
 * Validate untrusted action data without coercing malformed bounds into a fresh
 * history request. A single-message window may have identical endpoints.
 */
export function parseSummaryWindow(value: unknown): SummaryWindow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const { oldestTs, latestTs } = value as Record<string, unknown>;
  if (!isSlackTimestamp(oldestTs) || !isSlackTimestamp(latestTs) ||
      timestampMicros(oldestTs) > timestampMicros(latestTs)) {
    return null;
  }
  return { oldestTs, latestTs };
}

export function isValidSummaryWindow(value: unknown): value is SummaryWindow {
  return parseSummaryWindow(value) !== null;
}
