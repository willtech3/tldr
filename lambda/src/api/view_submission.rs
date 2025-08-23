use serde_json::Value;

use super::parsing::{v_array, v_path, v_str};
use crate::ai::prompt_builder::sanitize_custom_prompt;
use crate::core::models::ProcessingTask;
use crate::errors::SlackError;

pub fn build_task_from_view(
    user_id: &str,
    view: &Value,
    correlation_id: String,
) -> Result<ProcessingTask, SlackError> {
    let _ = v_path(view, &["state", "values"]) // ensure exists
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

    let mode = v_str(
        view,
        &[
            "state",
            "values",
            "range",
            "mode",
            "selected_option",
            "value",
        ],
    )
    .unwrap_or("unread_since_last_run");

    let message_count = v_str(view, &["state", "values", "lastn", "n", "value"])
        .and_then(|s| s.parse::<u32>().ok());

    let mut dest_canvas = false;
    let mut dest_dm = false;
    let mut dest_public_post = false;

    if let Some(selected) = v_array(
        view,
        &["state", "values", "dest", "dest_flags", "selected_options"],
    ) {
        for opt in selected {
            if let Some(val) = opt.get("value").and_then(|s| s.as_str()) {
                match val {
                    "canvas" => dest_canvas = true,
                    "dm" => dest_dm = true,
                    "public_post" => dest_public_post = true,
                    _ => {}
                }
            }
        }
    }

    let visible = dest_public_post;

    let custom_prompt = v_str(view, &["state", "values", "style", "custom", "value"])
        .map(|s| s.to_string())
        .and_then(|raw| sanitize_custom_prompt(&raw).ok());

    let effective_count = if mode == "last_n" {
        message_count
    } else {
        None
    };

    let mut text_parts = Vec::new();
    if let Some(count) = effective_count {
        text_parts.push(format!("count={}", count));
    }
    if let Some(ref prompt) = custom_prompt {
        let display_prompt = if prompt.chars().count() > 100 {
            let truncated: String = prompt.chars().take(97).collect();
            format!("custom=\"{}...\"", truncated)
        } else {
            format!("custom=\"{}\"", prompt)
        };
        text_parts.push(display_prompt);
    }
    if dest_public_post {
        text_parts.push("--visible".to_string());
    }
    let text = text_parts.join(" ");

    Ok(ProcessingTask {
        correlation_id,
        user_id: user_id.to_string(),
        channel_id,
        response_url: None,
        text,
        message_count: effective_count,
        target_channel_id: None,
        custom_prompt,
        visible,
        dest_canvas,
        dest_dm,
        dest_public_post,
    })
}
