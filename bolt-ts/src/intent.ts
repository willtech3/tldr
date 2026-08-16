/**
 * Intent parsing for user messages.
 *
 * Parses natural language commands from assistant thread messages.
 *
 * Precedence (most-specific first):
 *  1. clear/reset/remove style
 *  2. "style: ..." (anchored at start, so instructions may mention
 *     "help" or "summarize" without being misrouted)
 *  3. summarize (an explicit summary request wins over "help", so
 *     "help me summarize" runs a summary instead of printing the manual)
 *  4. help (the bare command only — conversational questions go to chat)
 *  5. unknown (the handler answers it as general chat via the model,
 *     falling back to a friendly nudge on failure — never silence)
 *
 * Chat is the default. "tldr" is also this app's NAME, so users address it
 * in conversation ("hey tldr, can you write a haiku?"); the name only counts
 * as a summarize command when the message *is* the command ("tldr",
 * "tldr #general last 50"). Same for bare counts: "last 100" alone is a
 * command, "in the last 2 weeks I read 3 books" is not.
 */

import { UserIntent } from './types';

/**
 * Supported natural-language summary commands. The trailing text is validated
 * separately so "summarize last 20" remains a command while "summarize how
 * photosynthesis works" remains an ordinary model query.
 */
const SUMMARY_REQUEST_LEAD =
  /^\s*(?:hey\s+tldr[\s,:!.-]*)?(?:(?:can|could|would|will)\s+you\s+|help\s+me\s+)?(?:please\s+)?(?:summarize|summarise|recap|catch\s+me\s+up|fill\s+me\s+in|what\s+did\s+i\s+miss|what\s+happened|give\s+me\s+(?:a\s+)?(?:summary|recap))\b[\s,:!.-]*/i;

/**
 * True when a summary verb is being used as a command, not merely discussed
 * in a question such as "what is abstractive summarization?". Suggested
 * prompts and typed commands lead with the verb; polite model-style requests
 * are covered by {@link SUMMARY_REQUEST_LEAD}.
 */
function isSummarizeRequest(text: string): boolean {
  const lead = text.match(SUMMARY_REQUEST_LEAD);
  if (!lead) {
    return false;
  }
  const residue = text
    .slice(lead[0].length)
    .replace(/\bwith\s+style\s*:[\s\S]*$/i, ' ')
    .replace(/<#[A-Z0-9]+(?:\|[^>]*)?>/g, ' ')
    .replace(/\blast\s+\d+\b/gi, ' ')
    .replace(/\bpost\s+here\b/gi, ' ')
    .replace(/\b(?:this|the|current)\s+channel\b/gi, ' ')
    .replace(/\bwhat\s+i\s+missed\b/gi, ' ')
    .replace(
      /\b(?:messages?|msgs?|please|pls|now|here|public|on|in|from|of|the)\b/gi,
      ' '
    )
    .replace(/[\s,.!?]+/g, '');
  return residue.length === 0;
}

/** A message that is just "last N [messages]" is a quick summarize command. */
const BARE_COUNT_COMMAND = /^\s*last\s+\d+(?:\s+(?:messages?|msgs?))?\s*[.!?]*\s*$/i;

/**
 * True when the message *is* the tl;dr command: bare ("tldr", "tl;dr!") or
 * followed only by command arguments ("tldr #general", "tldr last 50
 * please", "tldr with style: be funny"). Any other trailing text means the
 * user is talking *to* TLDR, not commanding it — that stays general chat,
 * and greetings like "hey tldr" never anchor as a command at all.
 */
function isTldrCommand(text: string): boolean {
  const lead = text.match(/^\s*tl;?dr\b[\s,:!.?-]*/i);
  if (!lead) {
    return false;
  }
  const residue = text
    .slice(lead[0].length)
    .replace(/\bwith\s+style\s*:[\s\S]*$/i, ' ')
    .replace(/<#[A-Z0-9]+(?:\|[^>]*)?>/g, ' ')
    .replace(/\blast\s+\d+\b/gi, ' ')
    .replace(/\b(?:messages?|msgs?|please|pls|now|here|post\s+here|public|this\s+channel|the\s+channel)\b/gi, ' ')
    .replace(/[\s,.!?]+/g, '');
  return residue.length === 0;
}

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
  // [\s\S] so a multi-line persona from a paste still saves as style.
  const styleMatch = text.match(/^\s*style\s*:\s*([\s\S]+?)\s*$/i);
  if (styleMatch) {
    const instructions = styleMatch[1]?.trim() ?? '';
    if (instructions.length > 0) {
      return { type: 'style', instructions };
    }
    return { type: 'help' };
  }

  // Parse per-run style override (doesn't persist)
  // Examples:
  // - "summarize with style: be funny"
  // - "summarize last 50 with style: write as haiku"
  // [\s\S] so a multi-line override is kept, not silently dropped.
  let styleOverride: string | null = null;
  const styleOverrideMatch = text.match(/with\s+style\s*:\s*([\s\S]+?)\s*$/i);
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

  const askedToRun =
    isSummarizeRequest(text) || isTldrCommand(text) || BARE_COUNT_COMMAND.test(text);

  if (askedToRun) {
    return {
      type: 'summarize',
      count,
      targetChannel,
      styleOverride,
    };
  }

  // Help intent — the bare command only. Capability questions and messages
  // that merely contain the word ("help me write an email") are general chat.
  if (
    /^\s*(?:please\s+)?help(?:\s+(?:me|please|pls))?\s*[.!?]*\s*$/i.test(text) ||
    textLower === '?'
  ) {
    return { type: 'help' };
  }

  return { type: 'unknown' };
}
