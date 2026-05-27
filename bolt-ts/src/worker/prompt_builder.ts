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
import { buildPrompt as buildBasePrompt, type ImageBlock, type PromptPayload } from '../ai/prompt';
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

/** Inline-image ceiling (bytes). Modern multimodal models accept larger
 *  attachments, but we keep an upper bound to protect Lambda memory and
 *  Anthropic per-request size limits. */
export const INLINE_IMAGE_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB
/** Conservative cap on inline images per summary to keep prompts focused. */
export const MAX_IMAGES_TOTAL = 8;
const MAX_RECEIPTS = 12;
const MAX_SNIPPET_CHARS = 100;

export interface SummarizePromptData {
  prompt: PromptPayload;
  linksShared: string[];
  receiptPermalinks: string[];
  hasAnyImages: boolean;
}

interface Receipt {
  permalink: string;
  author: string;
  snippet: string;
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
    return `[${msg.ts}] ${author}: ${msg.text}`;
  });

  const linksShared = extractLinksFromMessages(messages);

  const receiptSeeds = pickReceiptSeeds(messages, userNames);
  const permalinkResults = await Promise.all(
    receiptSeeds.map((seed) => getMessagePermalink(client, channelId, seed.ts))
  );
  const receipts: Receipt[] = [];
  for (let i = 0; i < receiptSeeds.length; i += 1) {
    const link = permalinkResults[i];
    if (link !== null) {
      receipts.push({
        permalink: link,
        author: receiptSeeds[i].author,
        snippet: receiptSeeds[i].snippet,
      });
    }
  }
  const receiptPermalinks = receipts.map((r) => r.permalink);

  const images: ImageBlock[] = [];
  for (const msg of messages) {
    if (images.length >= MAX_IMAGES_TOTAL) {
      break;
    }
    for (const file of msg.files) {
      if (images.length >= MAX_IMAGES_TOTAL) {
        break;
      }
      const url = pickFileDownloadUrl(file);
      if (!url) {
        continue;
      }
      const mimeHint = file.mimeType ?? '';
      const canonHint = canonicalizeMime(mimeHint);
      if (canonHint !== '' && !isAllowedImageMime(canonHint)) {
        continue;
      }

      try {
        const head = await fetchImageHead({ url, botToken: args.botToken, fetchImpl });
        if (head?.contentType) {
          const headCanon = canonicalizeMime(head.contentType);
          if (!headCanon.startsWith('image/') || !isAllowedImageMime(headCanon)) {
            continue;
          }
        }
        if (head?.contentLength && head.contentLength > INLINE_IMAGE_MAX_BYTES) {
          continue;
        }
        const bytes = await downloadImageBytes({
          url,
          botToken: args.botToken,
          maxBytes: INLINE_IMAGE_MAX_BYTES,
          fetchImpl,
        });
        const finalMime = canonHint || 'image/png';
        if (!isAllowedImageMime(finalMime)) {
          continue;
        }
        images.push(buildImageBlock(finalMime, bytes));
      } catch {
        // Skip individual image failures — non-fatal.
      }
    }
  }

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
    linksShared,
    receiptPermalinks,
    hasAnyImages: images.length > 0,
  };
}

/**
 * Safety-net: if the model omits required sections (`Links shared`, `Image
 * highlights`, `Receipts`), append minimal versions so the output is
 * consistent. Mutates the input string and returns the result.
 */
export function applySafetyNetSections(
  summary: string,
  data: { linksShared: string[]; receiptPermalinks: string[]; hasAnyImages: boolean }
): string {
  const lower = summary.toLowerCase();
  let out = summary;

  if (!lower.includes('links shared')) {
    out += '\n\n*Links shared*\n';
    if (data.linksShared.length === 0) {
      out += '- None\n';
    } else {
      for (const link of data.linksShared.slice(0, 30)) {
        out += `- ${link}\n`;
      }
    }
  }

  if (!lower.includes('image highlights')) {
    out += '\n\n*Image highlights*\n';
    out += data.hasAnyImages ? '- (No image highlights provided.)\n' : '- None\n';
  }

  if (!lower.includes('receipts')) {
    out += '\n\n*Receipts*\n';
    if (data.receiptPermalinks.length === 0) {
      out += '- None\n';
    } else {
      for (const link of data.receiptPermalinks.slice(0, MAX_RECEIPTS)) {
        out += `- ${link}\n`;
      }
    }
  }

  return out;
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

function pickReceiptSeeds(
  messages: RecentMessage[],
  userNames: Map<string, string>
): Array<{ ts: string; author: string; snippet: string }> {
  const seeds: Array<{ ts: string; author: string; snippet: string }> = [];
  for (const msg of messages) {
    const hasFiles = msg.files.length > 0;
    const hasLinks = extractLinksFromMessage(msg).length > 0;
    if (hasFiles || hasLinks) {
      seeds.push(toSeed(msg, userNames));
    }
  }
  if (seeds.length === 0) {
    for (const msg of messages.slice(0, MAX_RECEIPTS)) {
      seeds.push(toSeed(msg, userNames));
    }
  }
  return seeds.slice(0, MAX_RECEIPTS);
}

function toSeed(
  msg: RecentMessage,
  userNames: Map<string, string>
): { ts: string; author: string; snippet: string } {
  const author = msg.user ? userNames.get(msg.user) ?? msg.user : 'Unknown User';
  const raw = msg.text.replace(/\n/g, ' ');
  const clipped = [...raw];
  const snippet =
    clipped.length > MAX_SNIPPET_CHARS
      ? clipped.slice(0, MAX_SNIPPET_CHARS - 3).join('') + '...'
      : raw;
  return {
    ts: msg.ts,
    author,
    snippet: snippet.replaceAll('`', "'").trim(),
  };
}
