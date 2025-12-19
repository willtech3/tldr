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
  const textLower = text.toLowerCase();

  // Help intent
  if (textLower.includes('help') || textLower === '?' || textLower.includes('what can')) {
    return { type: 'help' };
  }

  // Customize/configure intent
  if (textLower.includes('customize') || textLower.includes('configure')) {
    return { type: 'customize' };
  }

  // Parse summarize intent
  const postHere = textLower.includes('post here') || textLower.includes('public');

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
    };
  }

  return { type: 'unknown' };
}
