//! Handler for Slack slash commands (`/tldr`).
//!
//! This module processes legacy slash command invocations.

use serde_json::Value;
use tracing::{error, info};
use uuid::Uuid;

use super::helpers::{ok_ephemeral, open_modal_with_timeout};
use super::parsing::{parse_kv_params, parse_slack_event};
use super::sqs;
use crate::core::config::AppConfig;
use crate::core::models::{Destination, ProcessingTask};
use crate::errors::SlackError;
use crate::slack::modal_builder::{Prefill, build_tldr_modal};

// ============================================================================
// Command Parsing
// ============================================================================

/// Parsed slash command options.
struct SlashCommandOptions {
    visible: bool,
    modal_mode: bool,
    message_count: Option<u32>,
    target_channel: Option<String>,
    custom_prompt: Option<String>,
}

/// Parse slash command text into structured options.
fn parse_slash_options(text: &str) -> SlashCommandOptions {
    let text_parts: Vec<&str> = text.split_whitespace().collect();

    let visible = text_parts
        .iter()
        .any(|&p| p == "--visible" || p == "--public");
    let modal_mode = text_parts.iter().any(|&p| p == "--ui" || p == "--modal");

    let filtered_text: String = text_parts
        .iter()
        .filter(|&&p| p != "--visible" && p != "--public" && p != "--ui" && p != "--modal")
        .copied()
        .collect::<Vec<&str>>()
        .join(" ");

    let (message_count, target_channel, custom_prompt) = parse_kv_params(&filtered_text);

    SlashCommandOptions {
        visible,
        modal_mode,
        message_count,
        target_channel,
        custom_prompt,
    }
}

// ============================================================================
// Main Entry Point
// ============================================================================

/// Handle a slash command from Slack.
///
/// # Arguments
/// - `config`: Application configuration
/// - `body`: The raw form-encoded body of the slash command
///
/// # Returns
/// A JSON response value to send back to Slack.
///
/// # Errors
/// Returns an error response if the body cannot be parsed.
pub async fn handle_slash_command(config: &AppConfig, body: &str) -> Result<Value, SlackError> {
    let slack_event = parse_slack_event(body)?;
    let options = parse_slash_options(&slack_event.text);

    // Modal mode: open the configuration modal
    if options.modal_mode {
        let prefill = Prefill {
            initial_conversation: Some(slack_event.channel_id.clone()),
            last_n: options.message_count,
            custom_prompt: options.custom_prompt,
        };
        let view = build_tldr_modal(&prefill);

        open_modal_with_timeout(config, &slack_event.trigger_id, &view, 2000).await;

        return Ok(ok_ephemeral("Opening TLDR configuration…"));
    }

    // Direct mode: enqueue a processing task
    let correlation_id = Uuid::new_v4().to_string();
    info!(
        "Slash command direct processing, correlation_id={}",
        correlation_id
    );

    let task = ProcessingTask {
        correlation_id: correlation_id.clone(),
        user_id: slack_event.user_id.clone(),
        channel_id: slack_event.channel_id.clone(),
        thread_ts: None,
        origin_channel_id: Some(slack_event.channel_id.clone()),
        response_url: Some(slack_event.response_url.clone()),
        text: slack_event.text.clone(),
        message_count: options.message_count,
        target_channel_id: options.target_channel.clone(),
        custom_prompt: options.custom_prompt,
        visible: options.visible,
        destination: if options.visible || options.target_channel.is_some() {
            Destination::Channel
        } else {
            Destination::DM
        },
        dest_canvas: false,
        dest_dm: false,
        dest_public_post: false,
    };

    if let Err(e) = sqs::send_to_sqs(&task, config).await {
        error!(
            "Failed to enqueue task (correlation_id={}): {}",
            correlation_id, e
        );
        return Ok(ok_ephemeral(&format!(
            "Failed to start summarization. Please try again. (ref: {})",
            &correlation_id[..8]
        )));
    }

    Ok(ok_ephemeral(
        "✨ Starting summarization... You'll receive the summary shortly.",
    ))
}
