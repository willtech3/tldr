use crate::core::{config::AppConfig, models::ProcessingTask};
use crate::{SlackError, slack_parser::decode_url_component};
use aws_sdk_sqs::Client as SqsClient;
use serde_json::Value;

/// Send a ProcessingTask to the configured SQS queue.
pub async fn send_to_sqs(task: &ProcessingTask, config: &AppConfig) -> Result<(), SlackError> {
    let queue_url = &config.processing_queue_url;
    let shared_config = aws_config::from_env().load().await;
    let client = SqsClient::new(&shared_config);
    let message_body = serde_json::to_string(task)
        .map_err(|e| SlackError::ApiError(format!("Failed to serialize task: {}", e)))?;
    client
        .send_message()
        .queue_url(queue_url)
        .message_body(message_body)
        .send()
        .await
        .map_err(|e| SlackError::AwsError(format!("Failed to send message to SQS: {}", e)))?;
    Ok(())
}

/// Detects whether the incoming body is a Slack interactive payload.
pub fn is_interactive_body(body: &str) -> bool {
    body.starts_with("payload=") || body.contains("&payload=")
}

/// Parses the interactive `payload` JSON from a form-encoded body.
pub fn parse_interactive_payload(form_body: &str) -> Result<Value, SlackError> {
    for pair in form_body.split('&') {
        if let Some(eq_idx) = pair.find('=') {
            let key = &pair[..eq_idx];
            if key == "payload" {
                let raw_val = &pair[eq_idx + 1..];
                let decoded = decode_url_component(raw_val).map_err(|e| {
                    SlackError::ParseError(format!("Failed to decode payload: {}", e))
                })?;
                let v: Value = serde_json::from_str(&decoded)
                    .map_err(|e| SlackError::ParseError(format!("Invalid JSON payload: {}", e)))?;
                return Ok(v);
            }
        }
    }
    Err(SlackError::ParseError("Missing payload field".to_string()))
}

// Helper: traverse a nested JSON object by path of keys.
fn v_path<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = root;
    for key in path {
        cur = cur.get(*key)?;
    }
    Some(cur)
}

// Helper: get a nested string value by path.
pub fn v_str<'a>(root: &'a Value, path: &[&str]) -> Option<&'a str> {
    v_path(root, path).and_then(|v| v.as_str())
}

pub fn v_array<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Vec<Value>> {
    v_path(root, path).and_then(|v| v.as_array())
}

/// Build a ProcessingTask from a `view_submission` payload's view.state.values
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
        .and_then(|raw| crate::sanitize_custom_prompt(&raw).ok());

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
