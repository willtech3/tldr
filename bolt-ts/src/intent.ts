/**
 * Intent parsing for user messages.
 *
 * Parses natural language commands from assistant thread messages.
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

  // Help intent
  if (textLower.includes('help') || textLower === '?' || textLower.includes('what can')) {
    return { type: 'help' };
  }

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

  // Extract channel mention like <#C123|name>
  let targetChannel: string | null = null;
  const channelMatch = text.match(/<#([A-Z0-9]+)\|[^>]+>/);
  if (channelMatch) {
    targetChannel = channelMatch[1];
  }

  const askedToRun = textLower.includes('summarize') || count !== null;

  if (askedToRun) {
    return {
      type: 'summarize',
      count,
      targetChannel,
      postHere,
      styleOverride,
    };
  }

  return { type: 'unknown' };
}
