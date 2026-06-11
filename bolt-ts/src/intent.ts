/**
 * Intent parsing for user messages.
 *
 * Parses natural language commands from assistant thread messages.
 *
 * Precedence (most-specific first):
 *  1. clear/reset/remove style
 *  2. "style: ..." (anchored at start, so instructions may mention
 *     "help" or "summarize" without being misrouted)
 *  3. summarize (any phrasing that asks for a summary wins over "help",
 *     so "help me summarize" runs a summary instead of printing the manual)
 *  4. help
 *  5. unknown (the handler answers it as general chat via the model,
 *     falling back to a friendly nudge on failure — never silence)
 */

import { UserIntent } from './types';

/** Phrasings that mean "summarize", beyond the literal verb. */
const SUMMARIZE_PHRASES =
  /summar|tl;?dr|recap|catch\s+me\s+up|fill\s+me\s+in|what\s+did\s+i\s+miss|what\s+happened/i;

/**
 * Parse user intent from message text.
 *
 * @param text - The raw message text from Slack
 * @returns The parsed user intent
 */
export function parseUserIntent(text: string): UserIntent {
  const textLower = text.toLowerCase().trim();

  // Clear style intent
  // Examples:
  // - "clear style"
  // - "reset style"
  // - "remove style"
  if (/^\s*(clear|reset|remove)\s+style\s*$/i.test(text)) {
    return { type: 'clear_style' };
  }

  // Style intent (thread-scoped; persisted via Slack message metadata)
  // Examples:
  // - "style: write as a haiku"
  // - "style : extremely concise"
  const styleMatch = text.match(/^\s*style\s*:\s*(.+?)\s*$/i);
  if (styleMatch) {
    const instructions = styleMatch[1]?.trim() ?? '';
    if (instructions.length > 0) {
      return { type: 'style', instructions };
    }
    return { type: 'help' };
  }

  // Parse summarize intent
  const postHere = textLower.includes('post here') || textLower.includes('public');

  // Parse per-run style override (doesn't persist)
  // Examples:
  // - "summarize with style: be funny"
  // - "summarize last 50 with style: write as haiku"
  let styleOverride: string | null = null;
  const styleOverrideMatch = text.match(/with\s+style\s*:\s*(.+?)$/i);
  if (styleOverrideMatch) {
    styleOverride = styleOverrideMatch[1]?.trim() || null;
  }

  // Parse "last N" pattern
  const words = textLower.split(/\s+/);
  let count: number | null = null;
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] === 'last') {
      const parsed = parseInt(words[i + 1], 10);
      if (!isNaN(parsed)) {
        count = parsed;
        break;
      }
    }
  }

  // Extract channel mention like <#C123|name> or <#C123>
  let targetChannel: string | null = null;
  const channelMatch = text.match(/<#([A-Z0-9]+)(?:\|[^>]*)?>/);
  if (channelMatch) {
    targetChannel = channelMatch[1];
  }

  const askedToRun = SUMMARIZE_PHRASES.test(textLower) || count !== null;

  if (askedToRun) {
    return {
      type: 'summarize',
      count,
      targetChannel,
      postHere,
      styleOverride,
    };
  }

  // Help intent — word-boundary match so "helpful" doesn't trigger it.
  if (/\bhelp\b/.test(textLower) || textLower === '?' || textLower.includes('what can')) {
    return { type: 'help' };
  }

  return { type: 'unknown' };
}
