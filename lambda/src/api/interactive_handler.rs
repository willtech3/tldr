//! Handler for Slack interactive components.
//!
//! This module processes interactive payloads including:
//! - `shortcut` / `message_action` - Global and message shortcuts
//! - `block_actions` - Button clicks, select menus
//! - `view_submission` - Modal form submissions

use serde_json::{Value, json};
use tracing::{error, info};
use uuid::Uuid;

use super::helpers::{
    ok_empty, ok_modal_clear, ok_modal_errors, open_modal_with_timeout, set_suggested_prompts_async,
};
use super::parsing::{v_array, v_str};
use super::sqs;
use super::view_submission;
use crate::core::config::AppConfig;
use crate::core::models::{Destination, ProcessingTask};
use crate::slack::modal_builder::{Prefill, build_tldr_modal};

// ============================================================================
// Shortcut Handlers
// ============================================================================

/// Handle `shortcut` or `message_action` interactive type.
async fn handle_shortcut(config: &AppConfig, payload: &Value) -> Value {
    let mut prefill = Prefill::default();
    if let Some(ch) = v_str(payload, &["channel", "id"]) {
        prefill.initial_conversation = Some(ch.to_string());
    }
    prefill.last_n = Some(100);

    let view = build_tldr_modal(&prefill);
    let trigger_id = v_str(payload, &["trigger_id"]).unwrap_or("");

    open_modal_with_timeout(config, trigger_id, &view, 2000).await;

    ok_empty()
}

// ============================================================================
// Block Action Handlers
// ============================================================================

/// Handle config button click - opens the TLDR modal.
async fn handle_config_button(config: &AppConfig, payload: &Value) -> Value {
    let prefill = Prefill {
        last_n: Some(100),
        ..Default::default()
    };

    let view = build_tldr_modal(&prefill);
    let trigger_id = v_str(payload, &["trigger_id"]).unwrap_or("");

    open_modal_with_timeout(config, trigger_id, &view, 2000).await;

    ok_empty()
}

/// Handle conversation picker from config flow - opens modal with channel prefilled.
async fn handle_config_conversation_pick(
    config: &AppConfig,
    payload: &Value,
    action: &Value,
) -> Value {
    let selected_channel = action
        .get("selected_conversation")
        .and_then(|v| v.as_str())
        .or_else(|| {
            action
                .get("selected_option")
                .and_then(|o| o.get("value"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("");

    if selected_channel.is_empty() {
        return ok_empty();
    }

    let prefill = Prefill {
        initial_conversation: Some(selected_channel.to_string()),
        last_n: Some(100),
        ..Default::default()
    };

    let view = build_tldr_modal(&prefill);
    let trigger_id = v_str(payload, &["trigger_id"]).unwrap_or("");

    open_modal_with_timeout(config, trigger_id, &view, 2000).await;

    ok_empty()
}

/// Handle conversation picker for summarization - enqueues a processing task.
async fn handle_summarize_conversation_pick(
    config: &AppConfig,
    payload: &Value,
    action: &Value,
) -> Value {
    // Support both conversations_select and static_select payload shapes
    let selected_channel = action
        .get("selected_conversation")
        .and_then(|v| v.as_str())
        .or_else(|| {
            action
                .get("selected_option")
                .and_then(|o| o.get("value"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("");

    if selected_channel.is_empty() {
        return ok_empty();
    }

    // Recover intent from block_id: unread vs last-N
    let block_id = action
        .get("block_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let message_count: Option<u32> = if let Some(n_str) = block_id.strip_prefix("tldr_pick_lastn_")
    {
        n_str.parse::<u32>().ok()
    } else {
        None
    };

    let channel_id = v_str(payload, &["channel", "id"])
        .or_else(|| v_str(payload, &["container", "channel_id"]))
        .unwrap_or("");
    let thread_ts = v_str(payload, &["container", "thread_ts"])
        .or_else(|| v_str(payload, &["message", "thread_ts"]))
        .or_else(|| v_str(payload, &["container", "message_ts"]))
        .unwrap_or("");
    let user_id = v_str(payload, &["user", "id"]).unwrap_or("");

    if channel_id.is_empty() || thread_ts.is_empty() || user_id.is_empty() {
        return ok_empty();
    }

    let correlation_id = Uuid::new_v4().to_string();
    let text = if let Some(n) = message_count {
        format!("summarize last {n}")
    } else {
        "summarize recent".to_string()
    };

    let task = ProcessingTask {
        correlation_id: correlation_id.clone(),
        user_id: user_id.to_string(),
        channel_id: selected_channel.to_string(),
        thread_ts: Some(thread_ts.to_string()),
        origin_channel_id: Some(channel_id.to_string()),
        response_url: None,
        text,
        message_count,
        target_channel_id: None,
        custom_prompt: None,
        visible: false,
        destination: Destination::Thread,
        dest_dm: false,
        dest_public_post: false,
    };

    if let Err(e) = sqs::send_to_sqs(&task, config).await {
        error!("enqueue failed from conv_pick: {}", e);
    } else {
        set_suggested_prompts_async(config, channel_id, thread_ts, &["Summarizing…"]);
    }

    ok_empty()
}

/// Handle `block_actions` interactive type.
async fn handle_block_actions(config: &AppConfig, payload: &Value) -> Value {
    let actions = v_array(payload, &["actions"]).cloned().unwrap_or_default();

    // Check for config button
    let open_clicked = actions.iter().any(|a| {
        a.get("action_id")
            .and_then(|id| id.as_str())
            .is_some_and(|id| id == "tldr_open_config")
    });
    if open_clicked {
        return handle_config_button(config, payload).await;
    }

    // Check for conversation selection
    if let Some(conv_action) = actions.iter().find(|a| {
        a.get("action_id")
            .and_then(|id| id.as_str())
            .is_some_and(|id| id == "tldr_pick_conv")
    }) {
        let block_id = conv_action
            .get("block_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // Route based on block_id context
        if block_id == "tldr_pick_config" {
            return handle_config_conversation_pick(config, payload, conv_action).await;
        }
        return handle_summarize_conversation_pick(config, payload, conv_action).await;
    }

    ok_empty()
}

// ============================================================================
// View Submission Handlers
// ============================================================================

/// Handle TLDR modal submission.
async fn handle_tldr_submission(
    config: &AppConfig,
    payload: &Value,
    view: &Value,
    correlation_id: String,
) -> Value {
    match crate::slack::modal_builder::validate_view_submission(view) {
        Ok(()) => {
            let user_id = v_str(payload, &["user", "id"]).unwrap_or("");
            let task = match view_submission::build_task_from_view(
                user_id,
                view,
                correlation_id.clone(),
            ) {
                Ok(t) => t,
                Err(e) => {
                    error!(
                        "Failed to build task (correlation_id={}): {}",
                        correlation_id, e
                    );
                    return ok_modal_errors(&json!({
                        "conv": format!("Error processing request (ref: {}). Please try again.", &correlation_id[..8])
                    }));
                }
            };

            if let Err(e) = sqs::send_to_sqs(&task, config).await {
                error!("Enqueue failed (correlation_id={}): {}", correlation_id, e);
                return ok_modal_errors(&json!({
                    "conv": format!("Unable to start job (ref: {}). Please try again.", &correlation_id[..8])
                }));
            }

            ok_modal_clear()
        }
        Err(errors) => ok_modal_errors(&Value::Object(errors)),
    }
}

/// Handle `view_submission` interactive type.
async fn handle_view_submission(config: &AppConfig, payload: &Value) -> Value {
    let correlation_id = Uuid::new_v4().to_string();
    info!(
        "view_submission received, correlation_id={}",
        correlation_id
    );

    let Some(view) = payload.get("view") else {
        return json!({
            "statusCode": 400,
            "body": json!({ "error": "Missing view in payload" }).to_string()
        });
    };

    handle_tldr_submission(config, payload, view, correlation_id).await
}

// ============================================================================
// Main Entry Point
// ============================================================================

/// Handle an interactive payload from Slack.
///
/// # Arguments
/// - `config`: Application configuration
/// - `payload`: The parsed interactive payload
///
/// # Returns
/// A JSON response value to send back to Slack.
pub async fn handle_interactive(config: &AppConfig, payload: &Value) -> Value {
    let payload_type = payload.get("type").and_then(|s| s.as_str()).unwrap_or("");

    match payload_type {
        "shortcut" | "message_action" => handle_shortcut(config, payload).await,
        "block_actions" => handle_block_actions(config, payload).await,
        "view_submission" => handle_view_submission(config, payload).await,
        _ => {
            info!("Unhandled interactive type: {}", payload_type);
            ok_empty()
        }
    }
}
