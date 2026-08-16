/**
 * Shared types used by event handlers and the worker pipeline.
 *
 * Previously this file mirrored the Rust SQS ProcessingTask. The single-service
 * refactor replaced the SQS payload with an in-memory `SummarizeRequest` — see
 * `worker/summarize.ts`.
 */

/** Parsed user intent from message text. */
export type UserIntent =
  | { type: 'help' }
  | { type: 'style'; instructions: string }
  | { type: 'clear_style' }
  | {
      type: 'summarize';
      count: number | null;
      targetChannel: string | null;
      /** Per-run style override (doesn't persist to thread state). */
      styleOverride: string | null;
    }
  | { type: 'unknown' };

/** Context tracking data stored in assistant-thread metadata. */
export interface ThreadContext {
  viewingChannelId: string | null;
  customStyle: string | null;
  defaultMessageCount: number | null;
}

/**
 * How a summarization run ended. `runSummarization` posts the appropriate
 * user-facing message for every outcome itself and never throws; callers use
 * the outcome to decide on follow-up touches (suggested prompts, titles).
 * `stopped` means the user clicked Slack's stop button on the streaming
 * message — no further messaging is appropriate.
 */
export type SummarizeOutcome = 'delivered' | 'empty' | 'too_large' | 'failed' | 'stopped';
