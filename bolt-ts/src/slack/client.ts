/**
 * Thin wrappers around Slack Web API methods we use in the worker path.
 *
 * Bolt's `WebClient` already exposes typed accessors for `chat.startStream`,
 * `chat.appendStream`, and `chat.stopStream`, plus the assistant-thread
 * helpers. This module centralises the smaller HTTP-level concerns we need
 * (rate-limit handling, image downloads, "not in streaming state" detection).
 */

import type { WebClient } from '@slack/web-api';

/** Slack-documented per-call character limit for `markdown_text` in chat.*Stream APIs. */
export const STREAM_MARKDOWN_TEXT_LIMIT = 12_000;

/** Sentinel error message returned by Slack when a streaming message has been finalised. */
export const ERROR_MESSAGE_NOT_IN_STREAMING_STATE = 'message_not_in_streaming_state';

/**
 * Result of `appendStream`. `Ok` means the append succeeded; `Closed` means the
 * Slack message left streaming state and the caller should stop appending.
 */
export type AppendStreamResult = { kind: 'ok' } | { kind: 'closed' };

export interface RecentMessage {
  ts: string;
  user: string | null;
  text: string;
  files: SlackFile[];
  blocks?: unknown;
  attachments?: unknown;
}

export interface SlackFile {
  /** Slack-private download URL. */
  urlPrivateDownload: string | null;
  /** Slack-private (view) URL. */
  urlPrivate: string | null;
  /** MIME type if Slack provided one. */
  mimeType: string | null;
}

export interface ImageHead {
  contentType: string | null;
  contentLength: number | null;
}

interface RawHistoryMessage {
  ts?: string;
  user?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
  files?: Array<{
    url_private_download?: string;
    url_private?: string;
    mimetype?: string;
  }>;
  blocks?: unknown;
  attachments?: unknown;
}

/** Fetch the latest `count` messages in a channel. */
export async function getRecentMessages(
  client: WebClient,
  channelId: string,
  count: number
): Promise<RecentMessage[]> {
  const limit = Math.min(Math.max(count, 1), 1000);
  const response = await client.conversations.history({ channel: channelId, limit });
  const messages = (response.messages ?? []) as RawHistoryMessage[];
  return messages.map(toRecentMessage);
}

function toRecentMessage(raw: RawHistoryMessage): RecentMessage {
  return {
    ts: raw.ts ?? '',
    user: raw.user ?? null,
    text: raw.text ?? '',
    files: (raw.files ?? []).map((f) => ({
      urlPrivateDownload: f.url_private_download ?? null,
      urlPrivate: f.url_private ?? null,
      mimeType: f.mimetype ?? null,
    })),
    blocks: raw.blocks,
    attachments: raw.attachments,
  };
}

/** Fetch the bot's own user ID via `auth.test`. */
export async function getBotUserId(client: WebClient): Promise<string | null> {
  try {
    const resp = await client.auth.test();
    return resp.user_id ?? null;
  } catch {
    return null;
  }
}

/** Fetch a real-name (or display-name) for a user, falling back to the userId. */
export async function getUserDisplayName(client: WebClient, userId: string): Promise<string> {
  try {
    const resp = await client.users.info({ user: userId });
    const profile = resp.user?.profile;
    return profile?.real_name ?? profile?.display_name ?? userId;
  } catch {
    return userId;
  }
}

/** Fetch the channel name (without leading `#`). Returns the channel ID on failure. */
export async function getChannelName(client: WebClient, channelId: string): Promise<string> {
  try {
    const resp = await client.conversations.info({ channel: channelId });
    const name = resp.channel && 'name' in resp.channel ? (resp.channel.name as string | undefined) : undefined;
    return name ?? channelId;
  } catch {
    return channelId;
  }
}

/** Fetch a permalink for a specific message. Returns null if Slack errors. */
export async function getMessagePermalink(
  client: WebClient,
  channelId: string,
  messageTs: string
): Promise<string | null> {
  try {
    const resp = await client.chat.getPermalink({ channel: channelId, message_ts: messageTs });
    return resp.permalink ?? null;
  } catch {
    return null;
  }
}

/**
 * Start a Slack streaming message. Bolt's WebClient generates the right API
 * call; we just normalise the response shape and surface the `ts` consumers need.
 */
export async function startStream(
  client: WebClient,
  args: { channel: string; threadTs: string; markdownText?: string }
): Promise<string> {
  const params: Record<string, unknown> = {
    channel: args.channel,
    thread_ts: args.threadTs,
  };
  if (args.markdownText !== undefined) {
    params.markdown_text = args.markdownText;
  }
  const resp = (await client.chat.startStream(params as never)) as { ts?: string };
  if (!resp.ts) {
    throw new Error('chat.startStream: missing ts in response');
  }
  return resp.ts;
}

/** Append text to an active streaming message. */
export async function appendStream(
  client: WebClient,
  args: { channel: string; ts: string; markdownText: string }
): Promise<AppendStreamResult> {
  try {
    await client.chat.appendStream({
      channel: args.channel,
      ts: args.ts,
      markdown_text: args.markdownText,
    } as never);
    return { kind: 'ok' };
  } catch (err) {
    if (isMessageNotInStreamingStateError(err)) {
      return { kind: 'closed' };
    }
    throw err;
  }
}

/** Finalise a streaming message, optionally appending final text/blocks/metadata. */
export async function stopStream(
  client: WebClient,
  args: {
    channel: string;
    ts: string;
    markdownText?: string;
    blocks?: unknown[];
    metadata?: { event_type: string; event_payload: Record<string, unknown> };
  }
): Promise<void> {
  const params: Record<string, unknown> = {
    channel: args.channel,
    ts: args.ts,
  };
  if (args.markdownText !== undefined) {
    params.markdown_text = args.markdownText;
  }
  if (args.blocks !== undefined) {
    params.blocks = args.blocks;
  }
  if (args.metadata !== undefined) {
    params.metadata = args.metadata;
  }
  try {
    await client.chat.stopStream(params as never);
  } catch (err) {
    if (isMessageNotInStreamingStateError(err)) {
      return;
    }
    throw err;
  }
}

/** Detect Slack's `message_not_in_streaming_state` error. */
export function isMessageNotInStreamingStateError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const data = (err as { data?: { error?: string } }).data;
  if (data?.error === ERROR_MESSAGE_NOT_IN_STREAMING_STATE) {
    return true;
  }
  const message = (err as Error).message ?? '';
  return message.includes(ERROR_MESSAGE_NOT_IN_STREAMING_STATE);
}

/** HEAD an image URL with bot auth to learn its content-type / size. */
export async function fetchImageHead(
  args: { url: string; botToken: string; fetchImpl?: typeof fetch }
): Promise<ImageHead | null> {
  const impl = args.fetchImpl ?? fetch;
  const resp = await impl(args.url, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${args.botToken}` },
  });
  if (!resp.ok) {
    return null;
  }
  const contentType = resp.headers.get('content-type');
  const contentLengthHeader = resp.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null;
  return {
    contentType,
    contentLength: Number.isFinite(contentLength) ? contentLength : null,
  };
}

/**
 * Download an image into memory with a strict size cap. Returns the raw bytes
 * for base64 encoding into a data URL.
 */
export async function downloadImageBytes(args: {
  url: string;
  botToken: string;
  maxBytes: number;
  fetchImpl?: typeof fetch;
}): Promise<Uint8Array> {
  if (args.maxBytes <= 0) {
    throw new Error('downloadImageBytes: maxBytes must be > 0');
  }
  const impl = args.fetchImpl ?? fetch;
  const resp = await impl(args.url, {
    headers: { Authorization: `Bearer ${args.botToken}` },
  });
  if (!resp.ok) {
    throw new Error(`Slack image download HTTP ${resp.status}`);
  }
  const contentLengthHeader = resp.headers.get('content-length');
  if (contentLengthHeader) {
    const sz = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(sz) && sz > args.maxBytes) {
      throw new Error(`Slack image too large to inline (${sz}B > ${args.maxBytes}B)`);
    }
  }
  const buffer = await resp.arrayBuffer();
  if (buffer.byteLength > args.maxBytes) {
    throw new Error(
      `Slack image too large to inline (exceeded ${args.maxBytes}B cap)`
    );
  }
  return new Uint8Array(buffer);
}

/** Pick the best download URL for a Slack file (private_download → private). */
export function pickFileDownloadUrl(file: SlackFile): string | null {
  return file.urlPrivateDownload ?? file.urlPrivate ?? null;
}
