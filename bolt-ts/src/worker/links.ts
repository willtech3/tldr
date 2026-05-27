/**
 * Link extraction from Slack messages. We extract:
 *  - Slack-link markup `<URL|label>` / `<URL>`
 *  - Raw URLs in message text and JSON-encoded blocks/attachments
 * and filter out Slack-permalink/file URLs (those are surfaced as "Receipts").
 */

const SLACK_LINK_RE = /<(https?:\/\/[^>|\s>]+)(?:\|[^>]+)?>/g;
const RAW_URL_RE = /https?:\/\/[^\s<>()[\]{}"'|]+/g;
const TRAILING_PUNCT = /[.,;:!?)\]}]+$/;

export interface SlackMessageLike {
  text?: string | null;
  blocks?: unknown;
  attachments?: unknown;
}

/**
 * Extract a deduplicated, normalised list of links from a batch of messages.
 */
export function extractLinksFromMessages(messages: SlackMessageLike[]): string[] {
  const raw: string[] = [];
  for (const msg of messages) {
    raw.push(...extractLinksFromMessage(msg));
  }
  return normaliseAndDedupe(raw);
}

export function extractLinksFromMessage(msg: SlackMessageLike): string[] {
  const out: string[] = [];
  if (typeof msg.text === 'string') {
    out.push(...extractLinksFromText(msg.text));
  }
  if (msg.blocks !== undefined && msg.blocks !== null) {
    out.push(...extractLinksFromJsonValue(msg.blocks));
  }
  if (msg.attachments !== undefined && msg.attachments !== null) {
    out.push(...extractLinksFromJsonValue(msg.attachments));
  }
  return out;
}

export function extractLinksFromText(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(SLACK_LINK_RE)) {
    out.push(trimTrailingPunct(match[1]));
  }
  for (const match of text.matchAll(RAW_URL_RE)) {
    out.push(trimTrailingPunct(match[0]));
  }
  return out;
}

function extractLinksFromJsonValue(value: unknown): string[] {
  const out: string[] = [];
  walk(value, out);
  return out;
}

function walk(node: unknown, out: string[]): void {
  if (node === null || node === undefined) {
    return;
  }
  if (typeof node === 'string') {
    for (const match of node.matchAll(RAW_URL_RE)) {
      out.push(trimTrailingPunct(match[0]));
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, out);
    }
    return;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) {
      walk(v, out);
    }
  }
}

/**
 * Normalise links: strip trailing punctuation and fragments, dedupe, filter
 * out Slack permalinks (those belong in receipts) and Slack file URLs.
 */
export function normaliseAndDedupe(rawLinks: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawLinks) {
    const trimmed = trimTrailingPunct(raw.trim());
    const normalised = normaliseLink(trimmed);
    if (normalised && !seen.has(normalised)) {
      seen.add(normalised);
      out.push(normalised);
    }
  }
  return out;
}

function normaliseLink(raw: string): string | null {
  let cleaned = raw.trim().replace(/^[<"']+|[>"']+$/g, '');
  if (!(cleaned.startsWith('http://') || cleaned.startsWith('https://'))) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return null;
  }
  url.hash = '';

  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const isMessagePermalink = host.endsWith('slack.com') && path.includes('/archives/');
  const isFileUrl =
    host === 'slack-files.com' ||
    host === 'files.slack.com' ||
    (host.endsWith('slack.com') && path.includes('/files-pri/'));

  if (isMessagePermalink || isFileUrl) {
    return null;
  }

  cleaned = url.toString();
  if (cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}

function trimTrailingPunct(value: string): string {
  return value.replace(TRAILING_PUNCT, '');
}
