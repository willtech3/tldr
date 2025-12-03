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
use crate::slack::SlackBot;
use crate::slack::modal_builder::{Prefill, build_share_modal, build_tldr_modal};

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

/// Handle share button click - opens the share modal.
async fn handle_share_button(config: &AppConfig, payload: &Value, action: &Value) -> Value {
    let meta = action.get("value").and_then(|v| v.as_str()).unwrap_or("");
    let has_custom = serde_json::from_str::<Value>(meta)
        .ok()
        .and_then(|v| v.get("has_custom_prompt").and_then(Value::as_bool))
        .unwrap_or(false);

    let view = build_share_modal(has_custom, meta);
    let trigger_id = v_str(payload, &["trigger_id"]).unwrap_or("");

    open_modal_with_timeout(config, trigger_id, &view, 2000).await;

    ok_empty()
}

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
        "summarize unread".to_string()
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
        dest_canvas: false,
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

    // Check for share button
    if let Some(share_action) = actions.iter().find(|a| {
        a.get("action_id")
            .and_then(|id| id.as_str())
            .is_some_and(|id| id == "tldr_share_open")
    }) {
        return handle_share_button(config, payload, share_action).await;
    }

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

/// Handle share modal submission.
async fn handle_share_submission(config: &AppConfig, payload: &Value, view: &Value) -> Value {
    // Extract private_metadata
    let meta_str = v_str(view, &["private_metadata"]).unwrap_or("");
    let meta: Value = serde_json::from_str(meta_str).unwrap_or(json!({}));
    let thread_ts = meta.get("thread_ts").and_then(|v| v.as_str()).unwrap_or("");
    let source_channel_id = meta
        .get("source_channel_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let message_count = meta
        .get("message_count")
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(0);
    let custom_prompt = meta
        .get("custom_prompt")
        .and_then(Value::as_str)
        .map(str::to_string);

    // Determine destination channel from modal
    let dest_channel = v_str(
        view,
        &[
            "state",
            "values",
            "share_dest",
            "share_conv",
            "selected_conversation",
        ],
    )
    .unwrap_or("");

    // Determine selected options
    let mut include_count = false;
    let mut include_custom = false;
    let mut include_user = false;

    if let Some(opts) = view
        .get("state")
        .and_then(|s| s.get("values"))
        .and_then(|v| v.get("share_opts"))
        .and_then(|b| b.get("share_flags"))
        .and_then(|a| a.get("selected_options"))
        .and_then(|o| o.as_array())
    {
        for o in opts {
            if let Some(val) = o.get("value").and_then(|v| v.as_str()) {
                match val {
                    "include_count" => include_count = true,
                    "include_custom" => include_custom = true,
                    "include_user" => include_user = true,
                    _ => {}
                }
            }
        }
    }

    // Get user ID from payload for attribution
    let user_id = v_str(payload, &["user", "id"]).unwrap_or("");

    // Fetch the summary text from the thread
    let summary_text = match SlackBot::new(config) {
        Ok(bot) => bot
            .slack_client()
            .get_summary_text_from_thread(source_channel_id, thread_ts)
            .await
            .unwrap_or_default(),
        Err(_) => String::new(),
    };

    // Compose share message with enhanced formatting
    let mut share_body = String::new();

    // Add attribution header if requested
    if include_user && !user_id.is_empty() {
        use std::fmt::Write as _;
        let _ = writeln!(share_body, "_Summary created by <@{user_id}>_");
    }

    // Add custom prompt prominently if included
    if include_custom
        && let Some(ref cp) = custom_prompt
        && !cp.is_empty()
    {
        use std::fmt::Write as _;
        let _ = writeln!(share_body, "✨ *Style: \"{cp}\"*");
    }

    // Add message count if included
    if include_count && message_count > 0 {
        use std::fmt::Write as _;
        let _ = writeln!(
            share_body,
            "📊 _Summary of {message_count} messages from <#{source_channel_id}>_"
        );
    }

    // Add separator if we have metadata
    if include_user || include_custom || include_count {
        share_body.push_str("\n───────────\n\n");
    }

    // Add the actual summary
    share_body.push_str(&summary_text);

    // Add footer
    share_body.push_str("\n\n_Generated with TLDR AI Assistant_");

    if let Ok(bot) = SlackBot::new(config)
        && !dest_channel.is_empty()
    {
        let _ = bot
            .slack_client()
            .post_message(dest_channel, &share_body)
            .await;
    }

    ok_modal_clear()
}

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

    // Route based on callback_id
    let callback_id = v_str(view, &["callback_id"]).unwrap_or("");

    match callback_id {
        "tldr_share_submit" => handle_share_submission(config, payload, view).await,
        _ => handle_tldr_submission(config, payload, view, correlation_id).await,
    }
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
