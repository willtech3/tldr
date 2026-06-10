/**
 * Preset summary styles shared by the suggested prompts, the per-summary
 * action buttons, and the post-summary follow-up prompts.
 */

export const ROAST_STYLE =
  'Write in a hyper-critical, sarcastic, and roasting tone. Point out inefficiencies, poor decisions, and ridiculous behavior. Be funny but brutal.';

export const RECEIPTS_STYLE =
  'Focus on finding contradictions, broken promises, and receipts. Point out when someone said they would do something and did not, or when people contradicted themselves. Be specific with timestamps and quotes.';

export const HAIKU_STYLE = 'Write the entire summary as a series of haiku. Keep the four sections.';

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
