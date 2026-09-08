/**
 * Compose the "Slack messages → Anthropic prompt" pipeline.
 *
 *  1. Fetch the channel name and the unique senders' display names.
 *  2. Format each message as `[ts] author: text`.
 *  3. Extract shared links, drop Slack permalinks/files.
 *  4. Pick up to 12 receipt messages (preferring ones with files/links), fetch
 *     their permalinks.
 *  5. Download inline images (per-file size cap, MIME guard) and convert them
 *     into Anthropic image content blocks.
 */

import type { WebClient } from '@slack/web-api';
import { buildPrompt as buildBasePrompt, type ImageBlock, type PromptPayload, type SourcedImage, type SummaryReceipt } from '../ai/prompt';
import { canonicalizeMime, isAllowedImageMime, buildImageBlock } from '../ai/images';
import {
  downloadImageBytes,
  fetchImageHead,
  getChannelName,
  getMessagePermalink,
  getUserDisplayName,
  pickFileDownloadUrl,
  type RecentMessage,
} from '../slack/client';
import { extractLinksFromMessage, extractLinksFromMessages } from './links';
import type { SummaryCoverage } from '../types';

/** Inline-image ceiling (bytes). Modern multimodal models accept larger
 *  attachments, but we keep an upper bound to protect Lambda memory and
 *  Anthropic per-request size limits. */
export const INLINE_IMAGE_MAX_BYTES = 4.5 * 1024 * 1024; // 4.5 MiB (kept under Anthropic's 5 MB/image limit)
/** Conservative cap on inline images per summary to keep prompts focused. */
export const MAX_IMAGES_TOTAL = 12;
const MAX_RECEIPTS = 12;
const MAX_SNIPPET_CHARS = 160;

export interface SummarizePromptData {
  prompt: PromptPayload;
  /** Human-readable channel name (no leading '#'); channel ID on lookup failure. */
  channelName: string;
  linksShared: string[];
  receiptPermalinks: string[];
  receipts: SummaryReceipt[];
  coverage: SummaryCoverage;
  hasAnyImages: boolean;
}

export interface BuildPromptDataArgs {
  client: WebClient;
  botToken: string;
  channelId: string;
  messages: RecentMessage[];
  customStyle: string | null;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export async function buildSummarizePromptData(
  args: BuildPromptDataArgs
): Promise<SummarizePromptData> {
  const { client, channelId, messages, customStyle } = args;
  const fetchImpl = args.fetchImpl ?? fetch;

  const [channelName, userNames] = await Promise.all([
    getChannelName(client, channelId),
    fetchUserNames(client, messages),
  ]);

  const formattedMessages = messages.map((msg) => {
    const author = msg.user ? userNames.get(msg.user) ?? msg.user : 'Unknown User';
    const attachment = msg.files.length > 0 ? ` [${msg.files.length} attachment${msg.files.length === 1 ? '' : 's'}]` : '';
    return `[${msg.ts}] ${author}: ${msg.text}${attachment}`;
  });

  const linksShared = extractLinksFromMessages(messages);

  const receiptSeeds = pickReceiptSeeds(messages, userNames);
  const permalinkResults = await Promise.all(
    receiptSeeds.map((seed) => getMessagePermalink(client, channelId, seed.ts))
  );
  const receipts: SummaryReceipt[] = [];
  const permalinksByTs = new Map<string, string>();
  for (let i = 0; i < receiptSeeds.length; i += 1) {
    const link = permalinkResults[i];
    if (link !== null) {
      permalinksByTs.set(receiptSeeds[i].ts, link);
      receipts.push({
        permalink: link,
        author: receiptSeeds[i].author,
        snippet: receiptSeeds[i].snippet,
        attachmentOnly: receiptSeeds[i].attachmentOnly,
      });
    }
  }
  const receiptPermalinks = receipts.map((r) => r.permalink);

  const images = await fetchInlineImages(
    collectImageCandidates(messages, userNames, permalinksByTs), args.botToken, fetchImpl
  );

  const prompt = buildBasePrompt({
    channelName,
    formattedMessages,
    linksShared,
    receipts,
    images,
    customStyle,
  });

  return {
    prompt,
    channelName,
    linksShared,
    receiptPermalinks,
    receipts,
    coverage: buildSummaryCoverage(messages),
    hasAnyImages: images.length > 0,
  };
}

/**
 * Add a compact, contextual source fallback only when the recap contains no
 * known receipt link. Empty inventories and image filler are never appended.
 * This stays append-only so streaming callers can send just the added suffix.
 */
export function applySafetyNetSections(
  summary: string,
  data: Pick<SummarizePromptData, 'receipts'>
): string {
  if (data.receipts.length === 0 || data.receipts.some((receipt) => summary.includes(receipt.permalink))) {
    return summary;
  }
  const sources = data.receipts.slice(0, 3).map((receipt) => {
    const label = `${receipt.author}: ${receipt.snippet || 'shared a message'}`;
    // Slack supplies the destination; source text belongs only in the label.
    const destination = receipt.permalink.replace(/[()\s<>]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
    return `- [${escapeMarkdownLabel(label)}](${destination})`;
  });
  return `${summary}\n\n**Sources**\n${sources.join('\n')}`;
}

function escapeMarkdownLabel(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]]/g, '\\$&');
}

/** Compute coverage from precisely the messages included in the model input. */
export function buildSummaryCoverage(messages: RecentMessage[]): SummaryCoverage {
  const timestamps = messages.map((message) => message.ts);
  const allValid = timestamps.length > 0 && timestamps.every((ts) =>
    /^\d{1,12}(?:\.\d{1,6})?$/.test(ts) && Number.isFinite(new Date(Number(ts) * 1000).getTime())
  );
  timestamps.sort((a, b) => Number(a) - Number(b));
  return {
    messageCount: messages.length,
    oldestTs: allValid ? timestamps[0] : null,
    latestTs: allValid ? timestamps[timestamps.length - 1] : null,
  };
}

interface ImageCandidate {
  url: string;
  /** Canonicalised MIME hint from Slack file metadata ('' when unknown). */
  canonHint: string;
  messageTs: string;
  author: string;
  permalink: string | null;
}

/**
 * Gather downloadable image candidates from messages, in order, applying only
 * the cheap MIME-hint pre-filter. The expensive HEAD/GET happen later in
 * {@link fetchInlineImages}.
 */
function collectImageCandidates(
  messages: RecentMessage[],
  userNames: Map<string, string>,
  permalinksByTs: Map<string, string>
): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  for (const msg of messages) {
    for (const file of msg.files) {
      const url = pickFileDownloadUrl(file);
      if (!url) {
        continue;
      }
      const canonHint = canonicalizeMime(file.mimeType ?? '');
      if (canonHint !== '' && !isAllowedImageMime(canonHint)) {
        continue;
      }
      candidates.push({
        url, canonHint, messageTs: msg.ts,
        author: msg.user ? userNames.get(msg.user) ?? msg.user : 'Unknown User',
        permalink: permalinksByTs.get(msg.ts) ?? null,
      });
    }
  }
  return candidates;
}

/**
 * Download up to {@link MAX_IMAGES_TOTAL} inline images. Candidates are fetched
 * in parallel batches (HEAD + GET per image) so a message window with many
 * attachments doesn't serialise the network round-trips. Order is preserved and
 * individual failures are skipped; we stop once enough images have succeeded.
 */
async function fetchInlineImages(
  candidates: ImageCandidate[],
  botToken: string,
  fetchImpl: typeof fetch
): Promise<SourcedImage[]> {
  const images: SourcedImage[] = [];
  for (
    let i = 0;
    i < candidates.length && images.length < MAX_IMAGES_TOTAL;
    i += MAX_IMAGES_TOTAL
  ) {
    const batch = candidates.slice(i, i + MAX_IMAGES_TOTAL);
    const blocks = await Promise.all(
      batch.map((candidate) => tryFetchImageBlock(candidate, botToken, fetchImpl))
    );
    for (let index = 0; index < blocks.length; index += 1) {
      const image = blocks[index];
      if (image && images.length < MAX_IMAGES_TOTAL) {
        const candidate = batch[index];
        images.push({ image, messageTs: candidate.messageTs, author: candidate.author, permalink: candidate.permalink });
      }
    }
  }
  return images;
}

/** Fetch + validate a single image, returning a content block or null on any
 *  failure (unsupported type, oversize, network error). */
async function tryFetchImageBlock(
  candidate: ImageCandidate,
  botToken: string,
  fetchImpl: typeof fetch
): Promise<ImageBlock | null> {
  try {
    const head = await fetchImageHead({ url: candidate.url, botToken, fetchImpl });
    if (head?.contentType) {
      const headCanon = canonicalizeMime(head.contentType);
      if (!headCanon.startsWith('image/') || !isAllowedImageMime(headCanon)) {
        return null;
      }
    }
    if (head?.contentLength && head.contentLength > INLINE_IMAGE_MAX_BYTES) {
      return null;
    }
    const bytes = await downloadImageBytes({
      url: candidate.url,
      botToken,
      maxBytes: INLINE_IMAGE_MAX_BYTES,
      fetchImpl,
    });
    const finalMime = candidate.canonHint || 'image/png';
    if (!isAllowedImageMime(finalMime)) {
      return null;
    }
    return buildImageBlock(finalMime, bytes);
  } catch {
    // Skip individual image failures — non-fatal.
    return null;
  }
}

async function fetchUserNames(
  client: WebClient,
  messages: RecentMessage[]
): Promise<Map<string, string>> {
  const userIds = new Set<string>();
  for (const msg of messages) {
    if (msg.user && msg.user !== 'Unknown User') {
      userIds.add(msg.user);
    }
  }
  const ids = [...userIds];
  const pairs = await Promise.all(
    ids.map(async (id) => [id, await getUserDisplayName(client, id)] as const)
  );
  return new Map(pairs);
}

interface ReceiptSeed extends Omit<SummaryReceipt, 'permalink'> {
  ts: string;
}

function pickReceiptSeeds(
  messages: RecentMessage[],
  userNames: Map<string, string>
): ReceiptSeed[] {
  if (messages.length <= MAX_RECEIPTS) {
    return messages.map((message) => toSeed(message, userNames));
  }
  // A shared image/link must not crowd every text-only source out of the
  // prompt. Sample both groups across the window, then fill remaining slots.
  const attachments = messages.filter((message) => message.files.length > 0 || extractLinksFromMessage(message).length > 0);
  const textOnly = messages.filter((message) => message.text.trim().length > 0 && !attachments.includes(message));
  const selected = new Map<string, RecentMessage>();
  for (const group of [attachments, textOnly]) {
    const count = Math.min(group.length, MAX_RECEIPTS / 2);
    for (let index = 0; index < count; index += 1) {
      const position = count === 1 ? 0 : Math.round(index * (group.length - 1) / (count - 1));
      selected.set(group[position].ts, group[position]);
    }
  }
  for (const message of messages) {
    if (selected.size >= MAX_RECEIPTS) {
      break;
    }
    selected.set(message.ts, message);
  }
  return [...selected.values()].map((message) => toSeed(message, userNames));
}

function toSeed(msg: RecentMessage, userNames: Map<string, string>): ReceiptSeed {
  const author = msg.user ? userNames.get(msg.user) ?? msg.user : 'Unknown User';
  const attachmentOnly = msg.text.trim().length === 0 && msg.files.length > 0;
  const attachmentLabel = msg.files.every((file) => file.mimeType?.startsWith('image/'))
    ? `shared ${msg.files.length === 1 ? 'an image' : 'images'}`
    : `shared ${msg.files.length === 1 ? 'an attachment' : 'attachments'}`;
  const raw = attachmentOnly ? attachmentLabel : msg.text.replace(/\s+/g, ' ').trim();
  const clipped = [...raw];
  const snippet = clipped.length > MAX_SNIPPET_CHARS
    ? clipped.slice(0, MAX_SNIPPET_CHARS - 3).join('') + '...'
    : raw;
  return { ts: msg.ts, author, snippet: snippet.replaceAll('`', "'"), attachmentOnly };
}
