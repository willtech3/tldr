/**
 * Load the conversation a channel recap is built from.
 *
 * `conversations.history` returns channel-level messages only, so on its own a
 * recap sees "Should we ship Friday? 🧵" and none of the forty replies that
 * decided it. This module fetches that history, drops TLDR's own posts, pulls
 * in the replies of the threads it found, and returns everything in reading
 * order: oldest first, each thread's replies directly under its parent.
 *
 * Thread reads are bounded (threads per recap, replies per thread, replies in
 * total) and best-effort: a thread that cannot be read is marked as omitted on
 * its parent instead of failing the recap, so the model can say a thread
 * exists without guessing what was said in it.
 */

import type { WebClient } from '@slack/web-api';
import { getBotUserId, getRecentMessages, getThreadReplies, isRateLimitedError, type RecentMessage } from '../slack/client';
import type { SummaryWindow } from '../types';

/** Threads read per recap, busiest first. */
export const MAX_THREADS_EXPANDED = 20;
/** Replies kept from a single thread. */
export const MAX_REPLIES_PER_THREAD = 60;
/** Replies kept across all threads of one recap. */
export const MAX_THREAD_REPLIES_TOTAL = 400;
/** Parallel `conversations.replies` calls per batch. */
const THREAD_FETCH_CONCURRENCY = 5;
/** When a thread is trimmed, keep this many opening replies; the rest of the allowance goes to its ending. */
const OPENING_REPLIES_KEPT = 10;

/**
 * Fetch up to `count` channel messages plus their thread replies. Returns an
 * empty list when nothing but TLDR's own posts was found.
 *
 * `threadClient` does the optional thread reads. Production passes a fail-fast
 * client (see `createBestEffortClient`) so a rate limit skips threads instead
 * of stalling the recap; it defaults to `client`.
 */
export async function loadSourceMessages(
  client: WebClient,
  channelId: string,
  count: number,
  window?: SummaryWindow,
  threadClient: WebClient = client
): Promise<RecentMessage[]> {
  const history = await getRecentMessages(client, channelId, count, window);
  // Don't let the bot summarize itself, and skip the threads under its posts.
  const botUserId = await getBotUserId(client);
  const channelMessages = botUserId ? history.filter((message) => message.user !== botUserId) : history;
  if (channelMessages.length === 0) {
    return [];
  }
  return expandThreadReplies({ client: threadClient, channelId, messages: channelMessages, botUserId, window });
}

interface ExpandArgs {
  client: WebClient;
  channelId: string;
  messages: RecentMessage[];
  botUserId: string | null;
  window?: SummaryWindow;
}

/** Interleave thread replies under their parents and order everything oldest first. */
export async function expandThreadReplies(args: ExpandArgs): Promise<RecentMessage[]> {
  const byAge = (a: RecentMessage, b: RecentMessage): number => Number(a.ts) - Number(b.ts);
  const parents = args.messages
    .filter((message) => (message.replyCount ?? 0) > 0 && message.ts.length > 0)
    .sort((a, b) => (b.replyCount ?? 0) - (a.replyCount ?? 0) || byAge(b, a));
  const chosen = parents.slice(0, MAX_THREADS_EXPANDED);

  const fetched = new Map<string, FetchedThread | null>();
  const state = { rateLimited: false };
  // Once Slack rate-limits a thread read, the rest would fail the same way: stop asking.
  for (let i = 0; i < chosen.length && !state.rateLimited; i += THREAD_FETCH_CONCURRENCY) {
    const batch = chosen.slice(i, i + THREAD_FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map((parent) => fetchReplies(args, parent, state)));
    batch.forEach((parent, index) => fetched.set(parent.ts, results[index]));
  }

  const allowances = shareAllowance(
    chosen.flatMap((parent) => {
      const thread = fetched.get(parent.ts);
      return thread ? [{ ts: parent.ts, size: thread.replies.length }] : [];
    })
  );
  const repliesByParent = new Map<string, RecentMessage[]>();
  const annotations = new Map<string, { shown: number; omitted: number }>();
  for (const parent of parents) {
    const thread = fetched.get(parent.ts) ?? null;
    const reported = parent.replyCount ?? 0;
    if (thread === null) {
      annotations.set(parent.ts, { shown: 0, omitted: reported });
      continue;
    }
    const { replies } = thread;
    const kept = trimThread(replies, allowances.get(parent.ts) ?? 0);
    // A thread Slack did not finish paging still has replies we never fetched.
    const unfetched = thread.truncated ? Math.max(0, reported - replies.length) : 0;
    repliesByParent.set(parent.ts, kept.map((reply) => ({ ...reply, parentTs: parent.ts })));
    annotations.set(parent.ts, { shown: kept.length, omitted: replies.length - kept.length + unfetched });
  }

  // A reply that was "also sent to the channel" shows up in history too; keep the threaded copy.
  const threadedTs = new Set<string>();
  for (const replies of repliesByParent.values()) {
    replies.forEach((reply) => threadedTs.add(reply.ts));
  }

  const ordered: RecentMessage[] = [];
  for (const message of [...args.messages].sort(byAge)) {
    if (threadedTs.has(message.ts)) {
      continue;
    }
    const note = annotations.get(message.ts);
    ordered.push(note ? { ...message, repliesShown: note.shown, repliesOmitted: note.omitted } : message);
    ordered.push(...(repliesByParent.get(message.ts) ?? []));
  }
  return ordered;
}

/**
 * Split the total reply allowance across threads, smallest thread first. A
 * short question-and-answer thread is cheap and gets read whole; whatever is
 * left is shared evenly between the long ones, so a few huge threads can never
 * crowd every other thread out.
 */
function shareAllowance(threads: Array<{ ts: string; size: number }>): Map<string, number> {
  const allowances = new Map<string, number>();
  let remaining = MAX_THREAD_REPLIES_TOTAL;
  const smallestFirst = [...threads].sort((a, b) => a.size - b.size);
  smallestFirst.forEach((thread, index) => {
    const fairShare = Math.floor(remaining / (smallestFirst.length - index));
    const allowance = Math.min(thread.size, MAX_REPLIES_PER_THREAD, fairShare);
    allowances.set(thread.ts, allowance);
    remaining -= allowance;
  });
  return allowances;
}

interface FetchedThread {
  replies: RecentMessage[];
  /** Slack had more replies than we paged through. */
  truncated: boolean;
}

/** Replies of one thread, oldest first, without the parent or TLDR's own posts. Null when unreadable. */
async function fetchReplies(
  args: ExpandArgs,
  parent: RecentMessage,
  state: { rateLimited: boolean }
): Promise<FetchedThread | null> {
  try {
    const thread = await getThreadReplies(args.client, args.channelId, parent.ts, { latestTs: args.window?.latestTs });
    const replies = thread.messages
      .filter((reply) => reply.ts !== parent.ts && reply.ts.length > 0)
      .filter((reply) => args.botUserId === null || reply.user !== args.botUserId)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    return { replies, truncated: thread.truncated };
  } catch (err) {
    // Best-effort. Slack's error object can echo request details, so it is not logged.
    if (isRateLimitedError(err)) {
      state.rateLimited = true;
    }
    return null;
  }
}

/** Keep how a long thread opened and, above all, how it ended. */
function trimThread(replies: RecentMessage[], allowance: number): RecentMessage[] {
  if (allowance <= 0) {
    return [];
  }
  if (replies.length <= allowance) {
    return replies;
  }
  const opening = Math.min(OPENING_REPLIES_KEPT, Math.floor(allowance / 2));
  return [...replies.slice(0, opening), ...replies.slice(replies.length - (allowance - opening))];
}
