//! Streaming delivery for assistant-thread summaries.
//!
//! This module implements end-to-end streaming for thread destinations using:
//! - `OpenAI` Responses API streaming (`stream: true`)
//! - Slack streaming Web API methods (`chat.startStream`, `chat.appendStream`, `chat.stopStream`)

use serde_json::{Value, json};
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

const FEEDBACK_ACTION_ID: &str = "tldr_feedback";

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

#[must_use]
fn build_feedback_blocks(correlation_id: &str) -> Value {
    let good_value = json!({
        "rating": "good",
        "correlation_id": correlation_id,
    })
    .to_string();
    let bad_value = json!({
        "rating": "bad",
        "correlation_id": correlation_id,
    })
    .to_string();

    json!([
        {
            "type": "context_actions",
            "elements": [
                {
                    "type": "feedback_buttons",
                    "action_id": FEEDBACK_ACTION_ID,
                    "positive_button": {
                        "text": { "type": "plain_text", "text": "Good Response" },
                        "value": good_value
                    },
                    "negative_button": {
                        "text": { "type": "plain_text", "text": "Bad Response" },
                        "value": bad_value
                    }
                }
            ]
        }
    ])
}

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

    let mut split_idx = prefix
        .rfind("\n\n")
        .filter(|&p| p > 0)
        .map(|p| p + 2)
        .or_else(|| prefix.rfind('\n').filter(|&p| p > 0).map(|p| p + 1));

    if split_idx.is_none() {
        let mut last_ws: Option<usize> = None;
        for (idx, ch) in prefix.char_indices() {
            if ch.is_whitespace() {
                last_ws = Some(idx + ch.len_utf8());
            }
        }
        split_idx = last_ws.filter(|&p| p > 0);
    }

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
) -> Result<bool, SlackError> {
    let Some(chunk) = take_stream_chunk(pending, max_chunk_chars) else {
        return Ok(true);
    };

    match slack_bot
        .slack_client()
        .append_stream(channel, stream_ts, &chunk)
        .await?
    {
        Ok(()) => Ok(true),
        Err(_) => Ok(false), // message_not_in_streaming_state
    }
}

async fn flush_all_pending(
    slack_bot: &SlackBot,
    channel: &str,
    stream_ts: &str,
    pending: &mut String,
    max_chunk_chars: usize,
    min_interval: Duration,
    last_append_at: &mut Option<Instant>,
) -> Result<bool, SlackError> {
    while !pending.is_empty() {
        sleep_for_append_interval(*last_append_at, min_interval).await;

        let ok = append_one_chunk(slack_bot, channel, stream_ts, pending, max_chunk_chars).await?;
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
    blocks: &Value,
) -> Result<(), SlackError> {
    match slack_bot
        .slack_client()
        .stop_stream(channel, stream_ts, None, Some(blocks), None)
        .await
    {
        Ok(()) => Ok(()),
        Err(SlackError::ApiError(ref msg)) if msg.contains("message_not_in_streaming_state") => {
            // Already finalized; best-effort attach blocks via chat.update.
            slack_bot
                .slack_client()
                .update_message(channel, stream_ts, None, Some(blocks))
                .await
        }
        Err(e) => Err(e),
    }
}

async fn ensure_canonical_failure(
    slack_bot: &SlackBot,
    channel: &str,
    thread_ts: &str,
    stream_ts: Option<&str>,
) {
    // Case 1: streaming never started → just post canonical error in-thread.
    let Some(ts) = stream_ts else {
        let _ = slack_bot
            .slack_client()
            .post_message_in_thread(channel, thread_ts, CANONICAL_FAILURE_MESSAGE)
            .await;
        return;
    };

    // Case 2: streaming started → stop stream, then ensure the visible message contains ONLY the canonical error.
    let _ = slack_bot
        .slack_client()
        .stop_stream(channel, ts, None, None, None)
        .await;

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
    let _ = slack_bot.slack_client().delete_message(channel, ts).await;
    let _ = slack_bot
        .slack_client()
        .post_message_in_thread(channel, thread_ts, CANONICAL_FAILURE_MESSAGE)
        .await;
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
            )
            .await?;
        } else {
            warn!(
                "Slack message left streaming state before flush completed (corr_id={})",
                task.correlation_id
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
                )
                .await?;
            }
        }

        let blocks = build_feedback_blocks(&task.correlation_id);
        if can_append {
            finalize_stream_success(slack_bot, assistant_channel, ts, &blocks).await?;
        } else {
            // Message already finalized; best effort attach blocks via chat.update.
            let _ = slack_bot
                .slack_client()
                .update_message(assistant_channel, ts, None, Some(&blocks))
                .await;
        }

        Ok(())
    }
    .await;

    if let Err(ref e) = result {
        error!(
            "Streaming summary failed (corr_id={}): {}",
            task.correlation_id, e
        );
        ensure_canonical_failure(
            slack_bot,
            assistant_channel,
            thread_ts,
            stream_ts.as_deref(),
        )
        .await;
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
