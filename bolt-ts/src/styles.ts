/**
 * Preset summary styles shared by the suggested prompts, the per-summary
 * action buttons, and the fresh-message menu.
 */

export const ROAST_STYLE =
  'Write a sharp, funny roast of the conversation, like a quick-witted friend in the group chat. Focus on specific jokes, self-owns, and ridiculous takes in the messages. Be sarcastic and playful; do not invent failures or claims.';

export const RECEIPTS_STYLE =
  'Pull receipts from the conversation: highlight contradictions or commitments only when the supplied messages demonstrate them. Use specific quotes and source links. If there is no clear contradiction or broken promise, say so briefly instead of manufacturing drama.';

export const HAIKU_STYLE = 'Write the entire summary as a short series of haiku. Keep useful source links.';

export const EXEC_BRIEF_STYLE =
  'Write an ultra-concise executive brief: maximum five bullets, no fluff, decisions and action items only.';

/**
 * Ready-made personas offered in the style modal's dropdown. `key` is what
 * goes in the Slack option `value` (capped at 150 chars by Slack — never put
 * the full style text there).
 */
export const STYLE_PRESETS: ReadonlyArray<{ key: string; label: string; value: string }> = [
  { key: 'roast', label: '🔥 Roast — funny but brutal', value: ROAST_STYLE },
  { key: 'receipts', label: '📜 Receipts — contradictions & broken promises', value: RECEIPTS_STYLE },
  { key: 'exec_brief', label: '💼 Executive brief — five bullets, no fluff', value: EXEC_BRIEF_STYLE },
  { key: 'haiku', label: '🌸 Haiku — yes, really', value: HAIKU_STYLE },
];

/** Sentinel dropdown option meaning "no special style". */
export const DEFAULT_STYLE_PRESET_KEY = '__default__';

/** Resolve a preset dropdown key back to its full style text (null = default). */
export function resolveStylePreset(key: string | null | undefined): string | null {
  if (!key || key === DEFAULT_STYLE_PRESET_KEY) {
    return null;
  }
  return STYLE_PRESETS.find((preset) => preset.key === key)?.value ?? null;
}

/** True when a style reads like the roast preset. */
export function isRoastStyle(style: string | null): boolean {
  return (style ?? '').toLowerCase().includes('roast');
}

/** True when a style reads like the receipts preset. */
export function isReceiptsStyle(style: string | null): boolean {
  return (style ?? '').toLowerCase().includes('receipt');
}

/** A readable label for the applied style; never echo arbitrary instructions. */
export function summaryStyleLabel(style: string | null): string | null {
  const trimmed = style?.trim();
  if (!trimmed) {
    return null;
  }
  const preset = STYLE_PRESETS.find((candidate) => candidate.value === trimmed);
  const labels: Record<string, string> = {
    roast: 'Roast', receipts: 'Receipts', exec_brief: 'Executive brief', haiku: 'Haiku',
  };
  return preset ? labels[preset.key] ?? 'Custom' : 'Custom';
}
