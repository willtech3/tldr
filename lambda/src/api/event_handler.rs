//! Handler for Slack Events API callbacks (AI App events).
//!
//! This module processes `event_callback` payloads including:
//! - `assistant_thread_started` - User opened the AI assistant
//! - `message.im` / `message` - User sent a message in the assistant thread

use serde_json::{Value, json};
use tracing::{error, info};
use uuid::Uuid;

use super::helpers::{ok_empty, post_blocks_with_timeout, set_suggested_prompts_async};
use super::sqs;
use crate::core::config::AppConfig;
use crate::core::models::{Destination, ProcessingTask};

// ============================================================================
// Block Kit Builders
// ============================================================================

fn build_welcome_blocks() -> Value {
    json!([
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "👋 Hi! I'm TLDR Bot. I can summarize channel messages for you.\n\n*Quick start:*\n• Click a suggested prompt below\n• Or type `help` to see all commands\n• Just type `summarize` to get started"
            }
        }
    ])
}

fn build_help_blocks() -> Value {
    json!([
        {
            "type": "header",
            "text": {"type": "plain_text", "text": "🤖 TLDR Bot Commands"}
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "*Basic Commands:*\n• `summarize` - Summarize recent messages from a channel\n• `summarize last 50` - Summarize the last 50 messages\n• `help` - Show this help message"
            }
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "*Advanced Features:*\n• `customize` or `configure` - Set custom prompt styles for a channel\n• Mention a channel (e.g., `summarize #general`) to target specific channels"
            }
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "*Tips:*\n• The bot will ask you to select a channel if you don't mention one\n• Summaries are sent as DMs by default\n• Add custom style prompts for creative summaries (poems, haikus, etc.)"
            }
        },
        {
            "type": "context",
            "elements": [
                {"type": "mrkdwn", "text": "Try one of the suggested prompts below or type your own command!"}
            ]
        }
    ])
}

fn build_configure_picker_blocks() -> Value {
    json!([
        { "type": "section", "text": {"type": "mrkdwn", "text": "Pick a conversation to configure TLDR for:"}},
        { "type": "actions", "block_id": "tldr_pick_config", "elements": [
            { "type": "conversations_select", "action_id": "tldr_pick_conv", "default_to_current_conversation": true, "response_url_enabled": true }
        ]}
    ])
}

fn build_channel_picker_blocks(block_id: &str, prompt_text: &str) -> Value {
    json!([
        { "type": "section", "text": {"type": "mrkdwn", "text": prompt_text}},
        { "type": "actions", "block_id": block_id, "elements": [
            { "type": "conversations_select", "action_id": "tldr_pick_conv", "default_to_current_conversation": true }
        ]}
    ])
}

// ============================================================================
// Intent Parsing
// ============================================================================

/// Parsed user intent from message text.
#[derive(Debug)]
pub enum UserIntent {
    Help,
    Customize,
    Summarize {
        count: Option<u32>,
        target_channel: Option<String>,
        post_here: bool,
    },
    Unknown,
}

/// Parse user intent from message text.
fn parse_user_intent(text: &str, raw_text: &str) -> UserIntent {
    let text_lc = text.to_lowercase();

    // Help intent
    if text_lc.contains("help") || text_lc == "?" || text_lc.contains("what can") {
        return UserIntent::Help;
    }

    // Customize/configure intent
    if text_lc.contains("customize") || text_lc.contains("configure") {
        return UserIntent::Customize;
    }

    // Parse summarize intent
    let post_here = text_lc.contains("post here") || text_lc.contains("public");

    // Parse "last N" pattern
    let count = text_lc
        .split_whitespace()
        .collect::<Vec<_>>()
        .windows(2)
        .find_map(|w| {
            if w[0] == "last" {
                w[1].parse::<u32>().ok()
            } else {
                None
            }
        });

    // Extract channel mention like <#C123|name>
    let target_channel = raw_text.split_whitespace().find_map(|tok| {
        if tok.starts_with("<#") && tok.contains('|') && tok.ends_with('>') {
            tok.trim_start_matches("<#")
                .split('|')
                .next()
                .map(ToString::to_string)
        } else {
            None
        }
    });

    let asked_to_run = text_lc.contains("summarize") || count.is_some();

    if asked_to_run {
        UserIntent::Summarize {
            count,
            target_channel,
            post_here,
        }
    } else {
        UserIntent::Unknown
    }
}

// ============================================================================
// Event Handlers
// ============================================================================

/// Handle `assistant_thread_started` event.
async fn handle_assistant_thread_started(config: &AppConfig, event: &Value) -> Value {
    let channel_id = event
        .get("assistant_thread")
        .and_then(|t| t.get("channel_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let thread_ts = event
        .get("assistant_thread")
        .and_then(|t| t.get("thread_ts"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if channel_id.is_empty() || thread_ts.is_empty() {
        return ok_empty();
    }

    // Set suggested prompts
    set_suggested_prompts_async(
        config,
        channel_id,
        thread_ts,
        &["Summarize recent", "Summarize last 50", "Help", "Configure"],
    );

    // Post welcome message
    let blocks = build_welcome_blocks();
    post_blocks_with_timeout(
        config,
        channel_id,
        Some(thread_ts),
        "Welcome to TLDR Bot",
        &blocks,
        1500,
    )
    .await;

    ok_empty()
}

/// Handle `message.im` or `message` event in assistant thread.
#[allow(clippy::too_many_lines)]
async fn handle_message_event(config: &AppConfig, event: &Value) -> Value {
    // Ignore bot messages and edited/system messages to avoid loops
    if event.get("bot_id").is_some() || event.get("subtype").is_some() {
        return ok_empty();
    }

    let channel_id = event.get("channel").and_then(|c| c.as_str()).unwrap_or("");
    let thread_ts = event
        .get("thread_ts")
        .and_then(|t| t.as_str())
        .or_else(|| event.get("ts").and_then(|t| t.as_str()))
        .unwrap_or("");
    let raw_text = event.get("text").and_then(|t| t.as_str()).unwrap_or("");
    let text_lc = raw_text.to_lowercase();
    let user_id = event.get("user").and_then(|u| u.as_str()).unwrap_or("");

    let intent = parse_user_intent(&text_lc, raw_text);

    match intent {
        UserIntent::Help => {
            let blocks = build_help_blocks();
            post_blocks_with_timeout(
                config,
                channel_id,
                Some(thread_ts),
                "TLDR Bot Help",
                &blocks,
                1500,
            )
            .await;
            ok_empty()
        }

        UserIntent::Customize => {
            let blocks = build_configure_picker_blocks();
            post_blocks_with_timeout(
                config,
                channel_id,
                Some(thread_ts),
                "Pick conversation",
                &blocks,
                1500,
            )
            .await;
            ok_empty()
        }

        UserIntent::Summarize {
            count,
            target_channel,
            post_here,
        } => {
            // If no channel specified, show channel picker
            if target_channel.is_none() {
                let block_id = if let Some(n) = count {
                    format!("tldr_pick_lastn_{n}")
                } else {
                    "tldr_pick_recent".to_string()
                };

                let prompt_text = if let Some(n) = count {
                    format!("Select a channel to summarize the last {n} messages:")
                } else {
                    "Select a channel to summarize recent messages:".to_string()
                };

                let blocks = build_channel_picker_blocks(&block_id, &prompt_text);
                post_blocks_with_timeout(
                    config,
                    channel_id,
                    Some(thread_ts),
                    "Choose channel",
                    &blocks,
                    1500,
                )
                .await;

                return ok_empty();
            }

            // Build and enqueue ProcessingTask
            if !channel_id.is_empty() && !thread_ts.is_empty() {
                let correlation_id = Uuid::new_v4().to_string();
                let task = ProcessingTask {
                    correlation_id: correlation_id.clone(),
                    user_id: user_id.to_string(),
                    channel_id: target_channel.unwrap_or_else(|| channel_id.to_string()),
                    thread_ts: Some(thread_ts.to_string()),
                    origin_channel_id: Some(channel_id.to_string()),
                    response_url: None,
                    text: text_lc,
                    message_count: count,
                    target_channel_id: None,
                    custom_prompt: None,
                    visible: post_here,
                    destination: Destination::Thread,
                    dest_dm: false,
                    dest_public_post: false,
                };

                if let Err(e) = sqs::send_to_sqs(&task, config).await {
                    error!("enqueue failed: {}", e);
                } else {
                    set_suggested_prompts_async(config, channel_id, thread_ts, &["Summarizing…"]);
                }
            }

            ok_empty()
        }

        UserIntent::Unknown => ok_empty(),
    }
}

// ============================================================================
// Main Entry Point
// ============================================================================

/// Handle an `event_callback` payload from Slack.
///
/// # Arguments
/// - `config`: Application configuration
/// - `json_body`: The full JSON body of the event callback
///
/// # Returns
/// A JSON response value to send back to Slack.
pub async fn handle_event_callback(config: &AppConfig, json_body: &Value) -> Value {
    // URL verification handshake
    if json_body
        .get("type")
        .and_then(|t| t.as_str())
        .is_some_and(|t| t == "url_verification")
    {
        let challenge = json_body
            .get("challenge")
            .and_then(|c| c.as_str())
            .unwrap_or("");
        return json!({
            "statusCode": 200,
            "body": challenge
        });
    }

    // Must be an event_callback
    let is_event_callback = json_body
        .get("type")
        .and_then(|t| t.as_str())
        .is_some_and(|t| t == "event_callback");

    if !is_event_callback {
        return ok_empty();
    }

    let Some(event) = json_body.get("event") else {
        return ok_empty();
    };

    let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
    info!(event_type = %event_type, "Processing event callback");

    match event_type {
        "assistant_thread_started" => handle_assistant_thread_started(config, event).await,
        "message.im" | "message" => handle_message_event(config, event).await,
        _ => {
            // No-op for other events
            ok_empty()
        }
    }
}
