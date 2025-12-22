//! Streaming delivery for assistant-thread summaries.
//!
//! # Overview
//!
//! This module implements end-to-end streaming for thread destinations by:
//! 1. Fetching channel messages via Slack API
//! 2. Streaming `OpenAI` responses via SSE (Server-Sent Events)
//! 3. Progressively appending chunks to Slack via `chat.*Stream` APIs
//!
//! # Error Handling
//!
//! On any failure, the module ensures the user sees a canonical failure message
//! and no partial streamed content remains visible. This is achieved through
//! [`ensure_canonical_failure`] which handles cleanup for both pre-stream and
//! mid-stream failures.
//!
//! # Key Invariants
//!
//! - Streaming is only started after the first non-empty `OpenAI` delta arrives
//! - Chunks respect Slack's 12,000 character markdown limit
//! - Rate limiting between appends is enforced via `stream_min_append_interval_ms`

use serde_json::json;
use slack_morphism::SlackHistoryMessage;
use std::time::Duration;
use tokio::time::Instant;
use tracing::{error, warn};

use crate::ai::{StreamEvent, StreamingResponse};
use crate::core::config::AppConfig;
use crate::core::models::ProcessingTask;
use crate::errors::SlackError;
use crate::slack::SlackBot;
use crate::slack::client::STREAM_MARKDOWN_TEXT_LIMIT;

const CANONICAL_FAILURE_MESSAGE: &str =
    "Sorry, I couldn't generate a summary at this time. Please try again later.";

#[must_use]
fn build_style_prefix(custom_prompt: Option<&str>) -> Option<String> {
    let style = custom_prompt
        .filter(|s| !s.trim().is_empty())
        .map(str::trim)?;

    let truncated = if style.chars().count() > 60 {
        let head: String = style.chars().take(57).collect();
        format!("{head}...")
    } else {
        style.to_string()
    };

    Some(format!("_Style: {truncated}_\n\n"))
}

#[must_use]
fn build_stream_prefix(task: &ProcessingTask) -> String {
    let mut prefix = String::new();
    if let Some(style) = build_style_prefix(task.custom_prompt.as_deref()) {
        prefix.push_str(&style);
    }
    prefix.push_str("*Summary from <#");
    prefix.push_str(&task.channel_id);
    prefix.push_str(">*\n\n");
    prefix
}

/// Find the byte index corresponding to `max_chars` Unicode characters.
///
/// This is necessary because Rust strings are UTF-8 encoded, where characters
/// may be 1-4 bytes. We cannot simply slice at byte position `max_chars`.
///
/// Returns `s.len()` if the string has fewer than `max_chars` characters.
#[must_use]
fn slice_end_for_max_chars(s: &str, max_chars: usize) -> usize {
    if max_chars == 0 {
        return 0;
    }

    for (count, (idx, _)) in s.char_indices().enumerate() {
        if count == max_chars {
            return idx;
        }
    }
    s.len()
}

/// Extract a chunk from the buffer, preferring natural break points.
///
/// # Split Priority (highest to lowest)
///
/// 1. **Paragraph boundary** (`\n\n`) - keeps logical sections together
/// 2. **Line boundary** (`\n`) - keeps sentences together
/// 3. **Whitespace** - avoids breaking mid-word
/// 4. **Hard character limit** - fallback when no natural break exists
///
/// This priority order ensures Slack messages render cleanly, avoiding
/// mid-word or mid-sentence breaks when possible.
///
/// # Returns
///
/// - `None` if buffer is empty
/// - `Some(chunk)` with the extracted text; the chunk is drained from `buffer`
///
/// # Unicode Safety
///
/// Uses [`slice_end_for_max_chars`] to handle multi-byte UTF-8 characters
/// correctly. Never splits in the middle of a Unicode codepoint.
#[must_use]
fn take_stream_chunk(buffer: &mut String, max_chars: usize) -> Option<String> {
    if buffer.is_empty() {
        return None;
    }

    let buffer_chars = buffer.chars().count();
    if buffer_chars <= max_chars {
        let out = buffer.clone();
        buffer.clear();
        return Some(out);
    }

    let byte_end = slice_end_for_max_chars(buffer, max_chars);
    let prefix = &buffer[..byte_end];

    // Priority 1 & 2: Look for paragraph or line boundaries
    let mut split_idx = prefix
        .rfind("\n\n")
        .filter(|&p| p > 0)
        .map(|p| p + 2)
        .or_else(|| prefix.rfind('\n').filter(|&p| p > 0).map(|p| p + 1));

    // Priority 3: Fall back to any whitespace boundary
    if split_idx.is_none() {
        let mut last_ws: Option<usize> = None;
        for (idx, ch) in prefix.char_indices() {
            if ch.is_whitespace() {
                last_ws = Some(idx + ch.len_utf8());
            }
        }
        split_idx = last_ws.filter(|&p| p > 0);
    }

    // Priority 4: Hard split at max_chars if no natural break found
    let split_idx = split_idx.unwrap_or(byte_end);
    Some(buffer.drain(..split_idx).collect())
}

async fn sleep_for_append_interval(last_append_at: Option<Instant>, min_interval: Duration) {
    if min_interval.is_zero() {
        return;
    }
    let Some(last) = last_append_at else {
        return;
    };

    let elapsed = last.elapsed();
    if elapsed < min_interval {
        tokio::time::sleep(min_interval - elapsed).await;
    }
}

async fn append_one_chunk(
    slack_bot: &SlackBot,
    channel: &str,
    stream_ts: &str,
    pending: &mut String,
    max_chunk_chars: usize,
    correlation_id: &str,
) -> Result<bool, SlackError> {
    let Some(chunk) = take_stream_chunk(pending, max_chunk_chars) else {
        return Ok(true);
    };

    if slack_bot
        .slack_client()
        .append_stream(channel, stream_ts, &chunk)
        .await?
        .is_ok()
    {
        Ok(true)
    } else {
        // Message transitioned out of streaming state (e.g., user clicked, timeout, etc.)
        warn!(
            "Slack message left streaming state during append (corr_id={}, lost {} chars)",
            correlation_id,
            chunk.chars().count()
        );
        Ok(false)
    }
}

#[allow(clippy::too_many_arguments)]
async fn flush_all_pending(
    slack_bot: &SlackBot,
    channel: &str,
    stream_ts: &str,
    pending: &mut String,
    max_chunk_chars: usize,
    min_interval: Duration,
    last_append_at: &mut Option<Instant>,
    correlation_id: &str,
) -> Result<bool, SlackError> {
    while !pending.is_empty() {
        sleep_for_append_interval(*last_append_at, min_interval).await;

        let ok = append_one_chunk(
            slack_bot,
            channel,
            stream_ts,
            pending,
            max_chunk_chars,
            correlation_id,
        )
        .await?;
        if !ok {
            return Ok(false);
        }
        *last_append_at = Some(Instant::now());
    }
    Ok(true)
}

async fn finalize_stream_success(
    slack_bot: &SlackBot,
    channel: &str,
    stream_ts: &str,
) -> Result<(), SlackError> {
    match slack_bot
        .slack_client()
        .stop_stream(channel, stream_ts, None, None, None)
        .await
    {
        Ok(()) => Ok(()),
        Err(SlackError::ApiError(ref msg)) if msg.contains("message_not_in_streaming_state") => {
            // Already finalized; nothing more to do.
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// Ensure the user sees the canonical failure message after a streaming error.
///
/// This function handles cleanup for both pre-stream and mid-stream failures,
/// guaranteeing users see a consistent error message regardless of when the failure occurred.
///
/// # Cleanup Strategy
///
/// - **Case 1 (streaming never started):** Post canonical error directly in-thread.
/// - **Case 2 (streaming started):** Stop stream, replace message content with canonical error,
///   or fall back to delete + post if update fails.
async fn ensure_canonical_failure(
    slack_bot: &SlackBot,
    channel: &str,
    thread_ts: &str,
    stream_ts: Option<&str>,
    correlation_id: &str,
) {
    // Case 1: streaming never started → just post canonical error in-thread.
    let Some(ts) = stream_ts else {
        if let Err(e) = slack_bot
            .slack_client()
            .post_message_in_thread(channel, thread_ts, CANONICAL_FAILURE_MESSAGE)
            .await
        {
            error!(
                "Failed to post canonical failure message (corr_id={}): {}",
                correlation_id, e
            );
        }
        return;
    };

    // Case 2: streaming started → stop stream, then ensure the visible message contains ONLY the canonical error.
    if let Err(e) = slack_bot
        .slack_client()
        .stop_stream(channel, ts, None, None, None)
        .await
    {
        warn!(
            "Failed to stop stream during cleanup (corr_id={}): {}",
            correlation_id, e
        );
    }

    let empty_blocks = json!([]);
    if slack_bot
        .slack_client()
        .update_message(
            channel,
            ts,
            Some(CANONICAL_FAILURE_MESSAGE),
            Some(&empty_blocks),
        )
        .await
        .is_ok()
    {
        return;
    }

    // Fallback: delete the streamed message, then post a fresh canonical error message.
    if let Err(e) = slack_bot.slack_client().delete_message(channel, ts).await {
        warn!(
            "Failed to delete streamed message during cleanup (corr_id={}): {}",
            correlation_id, e
        );
    }

    if let Err(e) = slack_bot
        .slack_client()
        .post_message_in_thread(channel, thread_ts, CANONICAL_FAILURE_MESSAGE)
        .await
    {
        error!(
            "Failed to post fallback canonical failure message (corr_id={}): {}",
            correlation_id, e
        );
    }
}

async fn fetch_messages_for_task(
    slack_bot: &mut SlackBot,
    task: &ProcessingTask,
) -> Result<Vec<SlackHistoryMessage>, SlackError> {
    let source_channel_id = &task.channel_id;
    let count = task.message_count.unwrap_or(50);

    let mut messages = slack_bot
        .slack_client()
        .get_recent_messages(source_channel_id, count)
        .await?;

    let is_public_or_visible = task.visible || task.dest_public_post;
    if let (true, Ok(bot_id)) = (
        is_public_or_visible,
        slack_bot.slack_client().get_bot_user_id().await,
    ) {
        messages.retain(|msg| {
            if let Some(user_id) = &msg.sender.user {
                user_id.0 != bot_id
            } else {
                true
            }
        });
    }

    Ok(messages)
}

/// Stream a summary into a Slack assistant thread (thread destination only).
///
/// On any failure, this function attempts to ensure the user sees the canonical failure message,
/// and that no partial streamed content remains visible.
///
/// # Errors
///
/// Returns a `SlackError` for the underlying failure (after best-effort cleanup), so callers can log it.
#[allow(clippy::too_many_lines)]
pub async fn stream_summary_to_assistant_thread(
    slack_bot: &mut SlackBot,
    config: &AppConfig,
    task: &ProcessingTask,
) -> Result<(), SlackError> {
    let thread_ts = task.thread_ts.as_deref().ok_or_else(|| {
        SlackError::GeneralError("Missing thread_ts for thread destination".to_string())
    })?;
    let assistant_channel = task
        .origin_channel_id
        .as_deref()
        .unwrap_or(&task.channel_id);

    let mut stream_ts: Option<String> = None;

    let result: Result<(), SlackError> = async {
        let messages = fetch_messages_for_task(slack_bot, task).await?;
        if messages.is_empty() {
            slack_bot
                .slack_client()
                .post_message_in_thread(
                    assistant_channel,
                    thread_ts,
                    "No messages found to summarize.",
                )
                .await?;
            return Ok(());
        }

        let mut data = slack_bot
            .build_summarize_prompt_data(&messages, &task.channel_id, task.custom_prompt.as_deref())
            .await?;

        let prefix = build_stream_prefix(task);

        let prompt = std::mem::take(&mut data.prompt);
        let stream_response = slack_bot
            .llm_client()
            .generate_summary_stream(prompt)
            .await?;

        // Too-large input short-circuit (no streaming)
        if stream_response.is_too_large() {
            let mut summary_text = StreamingResponse::too_large_message().to_string();
            SlackBot::apply_safety_net_sections(&mut summary_text, &data);
            let message = format!("{prefix}{summary_text}");
            slack_bot
                .slack_client()
                .post_message_in_thread(assistant_channel, thread_ts, &message)
                .await?;
            return Ok(());
        }

        let StreamingResponse::Active(mut active) = stream_response else {
            return Err(SlackError::OpenAIError(
                "Unexpected streaming response variant".to_string(),
            ));
        };

        let max_chunk_chars = config.stream_max_chunk_chars;
        let min_interval = Duration::from_millis(config.stream_min_append_interval_ms);
        let mut last_append_at: Option<Instant> = None;

        let mut pending = String::new();
        let mut collected = String::new();
        let mut can_append = true;

        // Stream events until completion. We do not create the Slack streaming message until the
        // first non-empty delta arrives, avoiding orphan "stuck streaming" messages on early failure.
        while let Some(event) = active.next_event().await? {
            match event {
                StreamEvent::TextDelta(delta) => {
                    if delta.is_empty() {
                        continue;
                    }

                    pending.push_str(&delta);
                    collected.push_str(&delta);

                    // Start Slack stream on first delta.
                    if stream_ts.is_none() {
                        let prefix_chars = prefix.chars().count();
                        if prefix_chars >= STREAM_MARKDOWN_TEXT_LIMIT {
                            return Err(SlackError::GeneralError(
                                "Streaming prefix exceeds Slack markdown limit".to_string(),
                            ));
                        }

                        let max_first = STREAM_MARKDOWN_TEXT_LIMIT
                            .saturating_sub(prefix_chars)
                            .min(max_chunk_chars);

                        if let Some(first_chunk) = take_stream_chunk(&mut pending, max_first) {
                            let initial_text = format!("{prefix}{first_chunk}");
                            let ts = slack_bot
                                .slack_client()
                                .start_stream(assistant_channel, thread_ts, Some(&initial_text))
                                .await?;
                            stream_ts = Some(ts);
                            last_append_at = Some(Instant::now());
                        }
                        continue;
                    }

                    // Periodic flush: at most one append per interval.
                    if !can_append {
                        continue;
                    }
                    if pending.is_empty() {
                        continue;
                    }
                    let Some(last) = last_append_at else {
                        continue;
                    };
                    if min_interval.is_zero() || last.elapsed() >= min_interval {
                        let Some(ts) = stream_ts.as_deref() else {
                            continue;
                        };
                        can_append = append_one_chunk(
                            slack_bot,
                            assistant_channel,
                            ts,
                            &mut pending,
                            max_chunk_chars,
                            &task.correlation_id,
                        )
                        .await?;
                        last_append_at = Some(Instant::now());
                    }
                }
                StreamEvent::Completed => break,
                StreamEvent::Failed(msg) | StreamEvent::Error(msg) => {
                    return Err(SlackError::OpenAIError(msg));
                }
            }
        }

        // If the model never emitted a delta, streaming never started. Treat as failure per spec.
        let Some(ts) = stream_ts.as_deref() else {
            return Err(SlackError::OpenAIError(
                "OpenAI stream completed without any output".to_string(),
            ));
        };

        // Flush any remaining streamed content.
        if can_append {
            can_append = flush_all_pending(
                slack_bot,
                assistant_channel,
                ts,
                &mut pending,
                max_chunk_chars,
                min_interval,
                &mut last_append_at,
                &task.correlation_id,
            )
            .await?;
        } else {
            warn!(
                "Slack message left streaming state before flush (corr_id={}, pending {} chars)",
                task.correlation_id,
                pending.chars().count()
            );
        }

        // Apply safety-net sections after OpenAI completes; append only what's missing.
        let before_len = collected.len();
        let mut finalized = collected;
        SlackBot::apply_safety_net_sections(&mut finalized, &data);
        if finalized.len() > before_len {
            pending.push_str(&finalized[before_len..]);
            if can_append {
                can_append = flush_all_pending(
                    slack_bot,
                    assistant_channel,
                    ts,
                    &mut pending,
                    max_chunk_chars,
                    min_interval,
                    &mut last_append_at,
                    &task.correlation_id,
                )
                .await?;
            }
        }

        if can_append {
            finalize_stream_success(slack_bot, assistant_channel, ts).await?;
        }
        // If !can_append, message was already finalized; nothing more to do.

        Ok(())
    }
    .await;

    if let Err(ref e) = result {
        error!(
            event = "tldr_streaming_failed",
            corr_id = %task.correlation_id,
            error = %e,
            "Streaming summary failed"
        );
        ensure_canonical_failure(
            slack_bot,
            assistant_channel,
            thread_ts,
            stream_ts.as_deref(),
            &task.correlation_id,
        )
        .await;
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─────────────────────────────────────────────────────────────────────────────
    // slice_end_for_max_chars tests
    // ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn slice_end_handles_ascii() {
        let s = "Hello, World!";
        assert_eq!(slice_end_for_max_chars(s, 5), 5);
        assert_eq!(&s[..slice_end_for_max_chars(s, 5)], "Hello");
    }

    #[test]
    fn slice_end_handles_multibyte_emoji() {
        // 😀 is 4 bytes in UTF-8
        let s = "Hello😀World";
        // "Hello" = 5 chars, "😀" = 1 char (4 bytes), total 6 chars for "Hello😀"
        let idx = slice_end_for_max_chars(s, 6);
        assert_eq!(&s[..idx], "Hello😀");
        // Verify we can safely slice at this index
        assert!(s.is_char_boundary(idx));
    }

    #[test]
    fn slice_end_handles_cjk_characters() {
        // Each CJK character is 3 bytes in UTF-8
        let s = "你好世界"; // 4 characters, 12 bytes
        let idx = slice_end_for_max_chars(s, 2);
        assert_eq!(&s[..idx], "你好");
        assert!(s.is_char_boundary(idx));
    }

    #[test]
    fn slice_end_handles_mixed_multibyte() {
        // Mix of ASCII (1 byte), emoji (4 bytes), and CJK (3 bytes)
        let s = "Hi🎉你好";
        // H=1, i=1, 🎉=1, 你=1, 好=1 = 5 chars
        let idx = slice_end_for_max_chars(s, 4);
        assert_eq!(&s[..idx], "Hi🎉你");
        assert!(s.is_char_boundary(idx));
    }

    #[test]
    fn slice_end_zero_max_returns_zero() {
        let s = "abc";
        assert_eq!(slice_end_for_max_chars(s, 0), 0);
    }

    #[test]
    fn slice_end_exceeds_string_length() {
        let s = "short";
        assert_eq!(slice_end_for_max_chars(s, 100), s.len());
    }

    #[test]
    fn slice_end_empty_string() {
        let s = "";
        assert_eq!(slice_end_for_max_chars(s, 5), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // take_stream_chunk boundary preference tests
    // ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn chunker_prefers_paragraph_boundaries() {
        let mut buf = "para1\n\npara2\n\npara3".to_string();
        let c1 = take_stream_chunk(&mut buf, 8).unwrap();
        assert_eq!(c1, "para1\n\n");
        let c2 = take_stream_chunk(&mut buf, 8).unwrap();
        assert_eq!(c2, "para2\n\n");
        let c3 = take_stream_chunk(&mut buf, 100).unwrap();
        assert_eq!(c3, "para3");
    }

    #[test]
    fn chunker_prefers_line_over_whitespace() {
        let mut buf = "line1\nword1 word2 word3".to_string();
        let c1 = take_stream_chunk(&mut buf, 10).unwrap();
        // Should prefer \n over space
        assert_eq!(c1, "line1\n");
        assert_eq!(buf, "word1 word2 word3");
    }

    #[test]
    fn chunker_falls_back_to_whitespace() {
        let mut buf = "word1 word2 word3 word4".to_string();
        let c1 = take_stream_chunk(&mut buf, 12).unwrap();
        // Should split at whitespace, not mid-word
        assert_eq!(c1, "word1 word2 ");
        assert_eq!(buf, "word3 word4");
    }

    #[test]
    fn chunker_falls_back_to_hard_split() {
        let mut buf = "abcdefghij".to_string();
        let c1 = take_stream_chunk(&mut buf, 4).unwrap();
        assert_eq!(c1.chars().count(), 4);
        let c2 = take_stream_chunk(&mut buf, 4).unwrap();
        assert_eq!(c2.chars().count(), 4);
        let c3 = take_stream_chunk(&mut buf, 4).unwrap();
        assert_eq!(c3.chars().count(), 2);
        assert!(buf.is_empty());
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // take_stream_chunk edge case tests
    // ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn chunker_returns_none_for_empty_buffer() {
        let mut buf = String::new();
        assert!(take_stream_chunk(&mut buf, 100).is_none());
    }

    #[test]
    fn chunker_returns_entire_buffer_when_smaller_than_max() {
        let mut buf = "short".to_string();
        let c1 = take_stream_chunk(&mut buf, 100).unwrap();
        assert_eq!(c1, "short");
        assert!(buf.is_empty());
    }

    #[test]
    fn chunker_handles_exact_fit() {
        let mut buf = "12345".to_string();
        let c1 = take_stream_chunk(&mut buf, 5).unwrap();
        assert_eq!(c1, "12345");
        assert!(buf.is_empty());
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // take_stream_chunk UTF-8 safety tests
    // ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn chunker_handles_emoji_at_boundary() {
        // Emoji at the exact boundary should not be split
        let mut buf = "Hello😀World".to_string();
        let c1 = take_stream_chunk(&mut buf, 6).unwrap();
        // "Hello😀" = 6 chars, should take all 6
        assert_eq!(c1, "Hello😀");
        assert_eq!(buf, "World");
    }

    #[test]
    fn chunker_handles_cjk_text() {
        let mut buf = "你好世界早上好".to_string(); // 7 CJK characters
        let c1 = take_stream_chunk(&mut buf, 4).unwrap();
        assert_eq!(c1.chars().count(), 4);
        assert_eq!(c1, "你好世界");
        assert_eq!(buf, "早上好");
    }

    #[test]
    fn chunker_handles_emoji_sequence() {
        // Multiple emojis in a row
        let mut buf = "🎉🎊🎈✨🌟".to_string(); // 5 emoji chars
        let c1 = take_stream_chunk(&mut buf, 3).unwrap();
        assert_eq!(c1.chars().count(), 3);
        assert_eq!(c1, "🎉🎊🎈");
        assert_eq!(buf, "✨🌟");
    }

    #[test]
    fn chunker_preserves_all_content() {
        // Verify no data loss with mixed content
        let original = "Hello 你好 🎉 World 世界!";
        let mut buf = original.to_string();
        let mut collected = String::new();

        while let Some(chunk) = take_stream_chunk(&mut buf, 5) {
            collected.push_str(&chunk);
        }

        assert_eq!(collected, original);
    }

    #[test]
    fn chunker_never_exceeds_max_chars() {
        let mut buf = "This is a longer string with multiple words and spaces".to_string();
        let max = 10;

        while let Some(chunk) = take_stream_chunk(&mut buf, max) {
            assert!(
                chunk.chars().count() <= max,
                "Chunk '{}' has {} chars, exceeds max {}",
                chunk,
                chunk.chars().count(),
                max
            );
        }
    }
}
