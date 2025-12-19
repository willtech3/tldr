use serde_json::Value;

use super::parsing::{v_path, v_str};
use crate::ai::prompt_builder::sanitize_custom_prompt;
use crate::core::models::{Destination, ProcessingTask};
use crate::errors::SlackError;

/// Build a `ProcessingTask` from a modal view submission.
///
/// Extracts: channel, message count, and optional custom prompt.
///
/// # Errors
///
/// Returns an error if the `view` lacks required fields to build a `ProcessingTask`.
pub fn build_task_from_view(
    user_id: &str,
    view: &Value,
    correlation_id: String,
) -> Result<ProcessingTask, SlackError> {
    let _ = v_path(view, &["state", "values"])
        .and_then(|v| v.as_object())
        .ok_or_else(|| SlackError::ParseError("view.state.values missing".to_string()))?;

    let channel_id = v_str(
        view,
        &[
            "state",
            "values",
            "conv",
            "conv_id",
            "selected_conversation",
        ],
    )
    .unwrap_or("")
    .to_string();

    let message_count = v_str(view, &["state", "values", "lastn", "n", "value"])
        .and_then(|s| s.parse::<u32>().ok());

    let custom_prompt = v_str(view, &["state", "values", "style", "custom", "value"])
        .map(std::string::ToString::to_string)
        .and_then(|raw| sanitize_custom_prompt(&raw).ok());

    // Build descriptive text for logging/debugging
    let mut text_parts = Vec::new();
    if let Some(count) = message_count {
        text_parts.push(format!("count={count}"));
    }
    if let Some(ref prompt) = custom_prompt {
        let display_prompt = if prompt.chars().count() > 100 {
            let truncated: String = prompt.chars().take(97).collect();
            format!("custom=\"{truncated}...\"")
        } else {
            format!("custom=\"{prompt}\"")
        };
        text_parts.push(display_prompt);
    }
    let text = text_parts.join(" ");

    Ok(ProcessingTask {
        correlation_id,
        user_id: user_id.to_string(),
        channel_id,
        thread_ts: None,
        origin_channel_id: None,
        response_url: None,
        text,
        message_count,
        target_channel_id: None,
        custom_prompt,
        visible: false,
        destination: Destination::Thread,
        dest_dm: false,
        dest_public_post: false,
    })
}
