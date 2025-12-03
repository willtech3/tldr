//! Common helper functions for API handlers.
//!
//! This module provides response builders and shared async operations
//! to reduce duplication across handlers.

use serde_json::{Value, json};
use std::time::Duration;
use tracing::error;

use crate::core::config::AppConfig;
use crate::slack::SlackBot;

// ============================================================================
// Response Builders
// ============================================================================

/// Returns a 200 OK response with an empty JSON body.
#[must_use]
pub fn ok_empty() -> Value {
    json!({ "statusCode": 200, "body": "{}" })
}

/// Returns a 200 OK response with an ephemeral Slack message.
#[must_use]
pub fn ok_ephemeral(text: &str) -> Value {
    json!({
        "statusCode": 200,
        "body": json!({ "response_type": "ephemeral", "text": text }).to_string()
    })
}

/// Returns a 200 OK response with a `response_action` for modals.
#[must_use]
pub fn ok_modal_clear() -> Value {
    json!({
        "statusCode": 200,
        "body": json!({ "response_action": "clear" }).to_string()
    })
}

/// Returns a 200 OK response with modal validation errors.
#[must_use]
pub fn ok_modal_errors(errors: &Value) -> Value {
    json!({
        "statusCode": 200,
        "body": json!({ "response_action": "errors", "errors": errors }).to_string()
    })
}

/// Returns an error response with the given status code and message.
#[must_use]
pub fn err_response(status_code: u16, message: &str) -> Value {
    json!({
        "statusCode": status_code,
        "body": json!({ "error": message }).to_string()
    })
}

/// Returns a 302 redirect response.
#[must_use]
pub fn redirect(url: &str) -> Value {
    json!({
        "statusCode": 302,
        "headers": { "Location": url },
        "body": ""
    })
}

// ============================================================================
// Modal Operations
// ============================================================================

/// Opens a modal with a timeout to avoid blocking the Slack ack.
///
/// This spawns an async task to open the modal and waits up to `timeout_ms`
/// for it to complete. If the timeout fires, the modal open continues in
/// the background.
pub async fn open_modal_with_timeout(
    config: &AppConfig,
    trigger_id: &str,
    view: &Value,
    timeout_ms: u64,
) {
    let config_clone = config.clone();
    let trigger_id = trigger_id.to_string();
    let view_clone = view.clone();

    let modal_handle = tokio::spawn(async move {
        match SlackBot::new(&config_clone) {
            Ok(bot) => {
                if let Err(e) = bot.open_modal(&trigger_id, &view_clone).await {
                    error!("Failed to open modal: {}", e);
                }
            }
            Err(e) => error!("Failed to initialize SlackBot for views.open: {}", e),
        }
    });

    let _ = tokio::time::timeout(Duration::from_millis(timeout_ms), modal_handle).await;
}

// ============================================================================
// Message Operations
// ============================================================================

/// Posts a message with blocks to a channel/thread with a timeout.
///
/// Fire-and-forget pattern for keeping Slack ack fast.
pub async fn post_blocks_with_timeout(
    config: &AppConfig,
    channel_id: &str,
    thread_ts: Option<&str>,
    text: &str,
    blocks: &Value,
    timeout_ms: u64,
) {
    let config_clone = config.clone();
    let channel_id = channel_id.to_string();
    let thread_ts = thread_ts.map(ToString::to_string);
    let text = text.to_string();
    let blocks = blocks.clone();

    let handle = tokio::spawn(async move {
        if let Ok(bot) = SlackBot::new(&config_clone) {
            let _ = bot
                .slack_client()
                .post_message_with_blocks(&channel_id, thread_ts.as_deref(), &text, &blocks)
                .await;
        }
    });

    let _ = tokio::time::timeout(Duration::from_millis(timeout_ms), handle).await;
}

/// Sets suggested prompts on an assistant thread (fire-and-forget).
pub fn set_suggested_prompts_async(
    config: &AppConfig,
    channel_id: &str,
    thread_ts: &str,
    prompts: &[&str],
) {
    let config_clone = config.clone();
    let channel_id = channel_id.to_string();
    let thread_ts = thread_ts.to_string();
    let prompts: Vec<String> = prompts.iter().map(|s| (*s).to_string()).collect();

    tokio::spawn(async move {
        if let Ok(bot) = SlackBot::new(&config_clone) {
            let prompt_refs: Vec<&str> = prompts.iter().map(String::as_str).collect();
            let _ = bot
                .slack_client()
                .assistant_set_suggested_prompts(&channel_id, &thread_ts, &prompt_refs)
                .await;
        }
    });
}
