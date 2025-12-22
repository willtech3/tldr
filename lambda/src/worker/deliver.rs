#![allow(clippy::too_many_lines)]
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::struct_excessive_bools)]
#![allow(clippy::uninlined_format_args)]
use reqwest::Client as HttpClient;
use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
use serde_json::{Value, json};
use tracing::{error, info};

use crate::core::models::{Destination, ProcessingTask};
use crate::errors::SlackError;
use crate::slack::SlackBot;
use crate::slack::message_formatter::format_summary_message;
use crate::slack::response_builder::create_ephemeral_payload;

pub async fn send_response_url(
    http_client: &HttpClient,
    slack_bot: &SlackBot,
    response_url: &str,
    message: &str,
    dm_fallback_user: Option<&str>,
) -> Result<(), SlackError> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let body = create_ephemeral_payload(message);
    let resp = http_client
        .post(response_url)
        .headers(headers)
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp
            .text()
            .await
            .unwrap_or_else(|_| "<failed to read body>".to_string());
        error!(
            "response_url POST failed: status={} body={}",
            status, body_text
        );
        if let Some(user_id) = dm_fallback_user {
            let _ = slack_bot
                .slack_client()
                .send_dm(user_id, message)
                .await
                .map_err(|dm_err| {
                    error!("DM fallback failed for user {}: {}", user_id, dm_err);
                    dm_err
                });
        }
    }
    Ok(())
}

pub async fn deliver_summary(
    slack_bot: &SlackBot,
    http_client: &HttpClient,
    task: &ProcessingTask,
    source_channel_id: &str,
    summary: &str,
) -> Result<(), SlackError> {
    let mut sent_successfully = false;

    // Primary thread delivery when specified
    if let (Destination::Thread, Some(thread_ts)) = (task.destination, task.thread_ts.as_deref()) {
        info!(
            "Replying in assistant thread {} in channel {} (corr_id={})",
            thread_ts,
            task.origin_channel_id
                .as_deref()
                .unwrap_or(source_channel_id),
            task.correlation_id
        );
        let reply_channel = task
            .origin_channel_id
            .as_deref()
            .unwrap_or(source_channel_id);

        // Format message with style header if custom_prompt is set
        let formatted_summary = if let Some(style) = &task.custom_prompt {
            let truncated_style = if style.len() > 60 {
                format!("{}...", &style[..57])
            } else {
                style.clone()
            };
            format!("_Style: {}_\n\n{}", truncated_style, summary)
        } else {
            summary.to_string()
        };

        // Build action buttons for thread summaries
        let action_buttons = build_summary_action_buttons(
            source_channel_id,
            task.message_count.unwrap_or(50),
            task.custom_prompt.as_deref(),
        );

        if let Err(e) = slack_bot
            .slack_client()
            .post_message_with_blocks(
                reply_channel,
                Some(thread_ts),
                &formatted_summary,
                &action_buttons,
            )
            .await
        {
            error!(
                "Failed to post in assistant thread: {} (corr_id={})",
                e, task.correlation_id
            );
        } else {
            sent_successfully = true;
        }
    }

    // Determine target-channel semantics when combined with `visible`:
    // - If a target is provided and it refers to the same channel as `source_channel_id`,
    //   we should only post once to the current channel.
    // - If a target is provided and it refers to a different channel, we should post
    //   only to the target (skip the source channel even if `visible` is set).
    let mut target_equals_source = false;
    if let Some(target) = task.target_channel_id.as_ref() {
        // Direct match against channel ID
        if target == source_channel_id {
            target_equals_source = true;
        } else if let Ok(src_name) = slack_bot
            .slack_client()
            .get_channel_name(source_channel_id)
            .await
        {
            let normalized = src_name.trim_start_matches('#').to_string();
            if *target == normalized {
                target_equals_source = true;
            }
        }
    }

    if task.dest_dm || matches!(task.destination, Destination::DM) {
        info!(
            "Sending summary via DM to user {} (corr_id={})",
            task.user_id, task.correlation_id
        );
        if let Err(e) = slack_bot
            .slack_client()
            .send_dm(&task.user_id, summary)
            .await
        {
            error!("Failed to send DM: {} (corr_id={})", e, task.correlation_id);
        } else {
            sent_successfully = true;
        }
    }

    // Public post to the source channel only when either:
    // - No target is provided; or
    // - Target is provided but it refers to the same channel as the source.
    if (task.dest_public_post || matches!(task.destination, Destination::Channel))
        && (task.target_channel_id.is_none() || target_equals_source)
    {
        info!(
            "Posting summary publicly to channel {} (corr_id={})",
            source_channel_id, task.correlation_id
        );
        let message_content =
            format_summary_message(&task.user_id, source_channel_id, &task.text, summary, true);
        if let Err(e) = slack_bot
            .slack_client()
            .post_message(source_channel_id, &message_content)
            .await
        {
            error!(
                "Failed to send public message: {} (corr_id={})",
                e, task.correlation_id
            );
        } else {
            sent_successfully = true;
        }
    }

    if let Some(target_channel) = task
        .target_channel_id
        .as_ref()
        .filter(|_| !target_equals_source)
    {
        info!(
            "Sending to target channel {} (corr_id={})",
            target_channel, task.correlation_id
        );
        let message_content = format_summary_message(
            &task.user_id,
            source_channel_id,
            &task.text,
            summary,
            task.visible,
        );
        if let Err(e) = slack_bot
            .slack_client()
            .post_message(target_channel, &message_content)
            .await
        {
            error!(
                "Failed to send to target channel: {} (corr_id={})",
                e, task.correlation_id
            );
        } else {
            sent_successfully = true;
        }
    }

    if task.visible && !task.dest_public_post && task.target_channel_id.is_none() {
        info!(
            "Legacy visible flag: posting publicly to {} (corr_id={})",
            source_channel_id, task.correlation_id
        );
        let message_content =
            format_summary_message(&task.user_id, source_channel_id, &task.text, summary, true);
        if let Err(e) = slack_bot
            .slack_client()
            .post_message(source_channel_id, &message_content)
            .await
        {
            error!(
                "Failed to send legacy visible message: {} (corr_id={})",
                e, task.correlation_id
            );
        } else {
            sent_successfully = true;
        }
    }

    if !sent_successfully && !task.dest_dm && !task.dest_public_post {
        info!(
            "No destinations selected or all failed, defaulting to DM (corr_id={})",
            task.correlation_id
        );
        if let Err(e) = slack_bot
            .slack_client()
            .send_dm(&task.user_id, summary)
            .await
        {
            error!(
                "Failed to send fallback DM: {} (corr_id={})",
                e, task.correlation_id
            );
            if let Some(resp_url) = &task.response_url {
                send_response_url(
                    http_client,
                    slack_bot,
                    resp_url,
                    "Sorry, I couldn't deliver the summary. Please try again.",
                    Some(&task.user_id),
                )
                .await?;
            }
        }
    }

    Ok(())
}

pub async fn notify_no_messages(
    slack_bot: &SlackBot,
    http_client: &HttpClient,
    task: &ProcessingTask,
) -> Result<(), SlackError> {
    let no_messages_text = "No messages found to summarize.";
    if let (Destination::Thread, Some(thread_ts)) = (task.destination, task.thread_ts.as_deref()) {
        let reply_channel = task
            .origin_channel_id
            .as_deref()
            .unwrap_or(&task.channel_id);
        let _ = slack_bot
            .slack_client()
            .post_message_in_thread(reply_channel, thread_ts, no_messages_text)
            .await;
    } else if task.dest_dm {
        let _ = slack_bot
            .slack_client()
            .send_dm(&task.user_id, no_messages_text)
            .await;
    } else if let Some(resp_url) = &task.response_url {
        send_response_url(
            http_client,
            slack_bot,
            resp_url,
            no_messages_text,
            Some(&task.user_id),
        )
        .await?;
    }
    Ok(())
}

/// Build Block Kit actions with Share/Roast/Receipts buttons for thread summaries.
///
/// Creates an actions block with three interactive buttons:
/// - 📤 Share to #channel - Posts summary back to source channel
/// - 🔥 Roast This - Reruns summary with roasting style (hidden if already roasting)
/// - 📜 Pull Receipts - Reruns summary with receipts style (hidden if already in receipts mode)
///
/// # Arguments
///
/// * `source_channel_id` - The channel ID being summarized
/// * `message_count` - Number of messages in the summary
/// * `current_style` - The current summary style (if any)
#[must_use]
pub(crate) fn build_summary_action_buttons(
    source_channel_id: &str,
    message_count: u32,
    current_style: Option<&str>,
) -> Value {
    let mut button_elements = vec![];

    // Share button - always shown
    let share_button_value = json!({
        "action": "share_summary",
        "sourceChannelId": source_channel_id,
        "count": message_count,
        "style": current_style,
    });

    button_elements.push(json!({
        "type": "button",
        "text": {
            "type": "plain_text",
            "text": "📤 Share to channel",
            "emoji": true
        },
        "action_id": "share_summary",
        "value": serde_json::to_string(&share_button_value).unwrap_or_default()
    }));

    // Roast button - only shown if NOT already roasting
    let is_roast_style = current_style.is_some_and(|s| s.to_lowercase().contains("roast"));

    if !is_roast_style {
        let roast_button_value = json!({
            "action": "rerun_roast",
            "channelId": source_channel_id,
            "count": message_count,
        });

        button_elements.push(json!({
            "type": "button",
            "text": {
                "type": "plain_text",
                "text": "🔥 Roast This",
                "emoji": true
            },
            "action_id": "rerun_roast",
            "value": serde_json::to_string(&roast_button_value).unwrap_or_default()
        }));
    }

    // Receipts button - only shown if NOT already in receipts mode
    let is_receipts_style = current_style.is_some_and(|s| s.to_lowercase().contains("receipt"));

    if !is_receipts_style {
        let receipts_button_value = json!({
            "action": "rerun_receipts",
            "channelId": source_channel_id,
            "count": message_count,
        });

        button_elements.push(json!({
            "type": "button",
            "text": {
                "type": "plain_text",
                "text": "📜 Pull Receipts",
                "emoji": true
            },
            "action_id": "rerun_receipts",
            "value": serde_json::to_string(&receipts_button_value).unwrap_or_default()
        }));
    }

    json!([{
        "type": "actions",
        "elements": button_elements
    }])
}
