/**
 * Shared types for the TLDR Bolt API Lambda.
 *
 * These types must match the Rust worker's expected message format.
 */

/**
 * Destination for summary delivery.
 * Must match the Rust enum in lambda/src/core/models.rs
 */
export type Destination = 'Thread' | 'DM' | 'Channel';

/**
 * Processing task sent to SQS for the Rust worker to process.
 * Must match the Rust struct in lambda/src/core/models.rs
 */
export interface ProcessingTask {
  correlation_id: string;
  user_id: string;
  channel_id: string;
  /** When present, indicates the Slack assistant thread timestamp to reply into */
  thread_ts: string | null;
  /** Original assistant channel id initiating the request (for replies) */
  origin_channel_id: string | null;
  response_url: string | null;
  text: string;
  message_count: number | null;
  target_channel_id: string | null;
  custom_prompt: string | null;
  visible: boolean;
  /** Preferred destination for primary delivery */
  destination: Destination;
  dest_dm: boolean;
  dest_public_post: boolean;
}

/**
 * Parsed user intent from message text.
 */
export type UserIntent =
  | { type: 'help' }
  | {
      type: 'style';
      instructions: string;
    }
  | { type: 'clear_style' }
  | {
      type: 'summarize';
      count: number | null;
      targetChannel: string | null;
      postHere: boolean;
      /** Per-run style override (doesn't persist to thread state) */
      styleOverride: string | null;
    }
  | { type: 'unknown' };

/**
 * Context tracking data stored in assistant thread state.
 */
export interface ThreadContext {
  /** The channel the user is currently viewing */
  viewingChannelId: string | null;
  /** Custom style prompt for this thread */
  customStyle: string | null;
}
