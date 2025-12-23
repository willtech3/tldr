/**
 * Slack-thread state persistence for the TLDR AI App.
 *
 * We persist thread-scoped state inside Slack using message metadata
 * (no database), and keep a small in-memory cache for fast lookups on warm
 * Lambda invocations.
 */

import type { ThreadContext } from './types';
import type { MessageMetadata } from '@slack/types';

export const TLDR_THREAD_STATE_EVENT_TYPE = 'tldr_thread_state';

/**
 * Minimal Slack message metadata shape we rely on.
 * Slack expects `event_type` (string) and `event_payload` (object).
 */
export type SlackMessageMetadata = MessageMetadata;

export interface SlackConversationMessage {
  ts?: string;
  metadata?: {
    event_type?: string;
    event_payload?: unknown;
  };
}

export interface SlackWebApiClient {
  conversations: {
    replies(args: {
      channel: string;
      ts: string;
      limit?: number;
      inclusive?: boolean;
      include_all_metadata?: boolean;
    }): Promise<{ messages?: SlackConversationMessage[] }>;
  };
}

export interface CachedThreadState {
  thread_key: string;
  state_message_ts: string;
  state: ThreadContext;
}

const threadStateCache = new Map<string, CachedThreadState>();

export function makeThreadKey(assistantChannelId: string, assistantThreadTs: string): string {
  return `${assistantChannelId}:${assistantThreadTs}`;
}

export function buildThreadStateMetadata(state: ThreadContext): SlackMessageMetadata {
  const payload: MessageMetadata['event_payload'] = { v: 1 };
  if (state.viewingChannelId) {
    payload.viewing_channel_id = state.viewingChannelId;
  }
  if (state.customStyle) {
    payload.custom_style = state.customStyle;
  }
  if (state.defaultMessageCount !== null && state.defaultMessageCount !== undefined) {
    payload.default_message_count = state.defaultMessageCount;
  }

  return {
    event_type: TLDR_THREAD_STATE_EVENT_TYPE,
    event_payload: payload,
  };
}

export function getCachedThreadState(threadKey: string): CachedThreadState | null {
  return threadStateCache.get(threadKey) ?? null;
}

export function setCachedThreadState(args: {
  threadKey: string;
  stateMessageTs: string;
  state: ThreadContext;
}): void {
  threadStateCache.set(args.threadKey, {
    thread_key: args.threadKey,
    state_message_ts: args.stateMessageTs,
    state: args.state,
  });
}

export function parseThreadContextFromMetadata(eventPayload: unknown): ThreadContext {
  const defaultState: ThreadContext = {
    viewingChannelId: null,
    customStyle: null,
    defaultMessageCount: null,
  };

  if (typeof eventPayload !== 'object' || eventPayload === null) {
    return defaultState;
  }

  const payload = eventPayload as Record<string, unknown>;

  const viewingChannelId =
    typeof payload.viewing_channel_id === 'string' ? payload.viewing_channel_id : null;
  const customStyle = typeof payload.custom_style === 'string' ? payload.custom_style : null;
  const defaultMessageCount =
    typeof payload.default_message_count === 'number' ? payload.default_message_count : null;

  return { viewingChannelId, customStyle, defaultMessageCount };
}

export async function findThreadStateMessage(args: {
  client: SlackWebApiClient;
  assistantChannelId: string;
  assistantThreadTs: string;
}): Promise<CachedThreadState | null> {
  const threadKey = makeThreadKey(args.assistantChannelId, args.assistantThreadTs);

  const cached = getCachedThreadState(threadKey);
  if (cached) {
    return cached;
  }

  const resp = await args.client.conversations.replies({
    channel: args.assistantChannelId,
    ts: args.assistantThreadTs,
    // Threads can get long, but state message should be near the beginning.
    // We keep this small to protect the 3s ACK window.
    limit: 20,
    inclusive: true,
    include_all_metadata: true,
  });

  const messages = resp.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const metadata = msg.metadata;
    if (!metadata || metadata.event_type !== TLDR_THREAD_STATE_EVENT_TYPE) {
      continue;
    }
    const ts = msg.ts;
    if (!ts) {
      continue;
    }

    const state = parseThreadContextFromMetadata(metadata.event_payload);
    const found: CachedThreadState = {
      thread_key: threadKey,
      state_message_ts: ts,
      state,
    };
    threadStateCache.set(threadKey, found);
    return found;
  }

  return null;
}


