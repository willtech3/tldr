/**
 * Intent parsing for user messages.
 *
 * Parses natural language commands from assistant thread messages.
 *
 * Ordering matters: the structured commands (`clear style`, `style:`,
 * `summarize`) are matched on their explicit markers *before* the catch-all
 * `help` check, and `help` is matched as a whole word — otherwise a message
 * like `style: be more helpful` or `summarize the #help-desk channel` would be
 * misread as a help request because it merely contains the substring "help".
 */

import { UserIntent } from './types';

/**
 * Parse user intent from message text.
 *
 * @param text - The raw message text from Slack
 * @returns The parsed user intent
 */
export function parseUserIntent(text: string): UserIntent {
  const textLower = text.toLowerCase().trim();

  // Clear style intent (anchored).
  // Examples:
  // - "clear style"
  // - "reset style"
  // - "remove style"
  if (/^\s*(clear|reset|remove)\s+style\s*$/i.test(text)) {
    return { type: 'clear_style' };
  }

  // Style intent (thread-scoped; persisted via Slack message metadata).
  // Anchored so it wins over the help check even when the instructions contain
  // the word "help" (e.g. "style: be more helpful").
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

  // Parse per-run style override (doesn't persist).
  // Examples:
  // - "summarize with style: be funny"
  // - "summarize last 50 with style: write as haiku"
  let styleOverride: string | null = null;
  const styleOverrideMatch = text.match(/with\s+style\s*:\s*(.+?)$/i);
  if (styleOverrideMatch) {
    styleOverride = styleOverrideMatch[1]?.trim() || null;
  }

  // Parse "last N" pattern.
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

  // Extract channel mention like <#C123|name>.
  let targetChannel: string | null = null;
  const channelMatch = text.match(/<#([A-Z0-9]+)\|[^>]+>/);
  if (channelMatch) {
    targetChannel = channelMatch[1];
  }

  // Summarize intent — explicit keyword or a "last N" count. Checked before
  // `help` so commands such as "summarize the #help-desk channel" or
  // "summarize last 100 when you get a chance, would help" are not swallowed by
  // the help matcher.
  const askedToRun = /\bsummari[sz]e\b/i.test(text) || count !== null;
  if (askedToRun) {
    return {
      type: 'summarize',
      count,
      targetChannel,
      styleOverride,
    };
  }

  // Help intent — matched as a whole word so "helpful" / "unhelpful" don't
  // trigger it, and only after the structured commands above have had a chance
  // to match.
  if (/\bhelp\b/i.test(text) || textLower === '?' || /\bwhat can\b/i.test(textLower)) {
    return { type: 'help' };
  }

  return { type: 'unknown' };
}
