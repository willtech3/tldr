#![allow(clippy::too_many_lines)]
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::struct_excessive_bools)]
#![allow(clippy::uninlined_format_args)]
use reqwest::Client as HttpClient;
use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
use tracing::{error, info};

use crate::core::models::ProcessingTask;
use crate::errors::SlackError;
use crate::slack::message_formatter::format_summary_message;
use crate::slack::response_builder::create_ephemeral_payload;
use crate::slack::{CanvasHelper, SlackBot};

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

    if task.dest_canvas {
        info!(
            "Writing summary to Canvas for channel {} (corr_id={})",
            source_channel_id, task.correlation_id
        );
        let canvas_helper = CanvasHelper::new(slack_bot.slack_client());
        match canvas_helper.ensure_channel_canvas(source_channel_id).await {
            Ok(canvas_id) => {
                use chrono_tz::US::Central;
                let now = chrono::Utc::now().with_timezone(&Central);
                let tz_abbr = if now.format("%Z").to_string() == "CDT" {
                    "CDT"
                } else {
                    "CST"
                };
                let heading = format!(
                    "TLDR - {} {} (God's time zone)",
                    now.format("%Y-%m-%d %H:%M"),
                    tz_abbr
                );
                let user_name = match slack_bot.slack_client().get_user_info(&task.user_id).await {
                    Ok(name) => name,
                    Err(_) => format!("<@{}>", task.user_id),
                };
                let canvas_content =
                    format!("{summary}\n\n*Summary by {user_name} using TLDR bot*");
                if let Err(e) = canvas_helper
                    .prepend_summary_section(&canvas_id, &heading, &canvas_content)
                    .await
                {
                    error!(
                        "Failed to update Canvas: {} (corr_id={})",
                        e, task.correlation_id
                    );
                } else {
                    info!(
                        "Successfully updated Canvas {} (corr_id={})",
                        canvas_id, task.correlation_id
                    );
                    sent_successfully = true;
                }
            }
            Err(e) => {
                error!("Failed to ensure Canvas exists: {}", e);
            }
        }
    }

    if task.dest_dm {
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
    if task.dest_public_post && (task.target_channel_id.is_none() || target_equals_source) {
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

    if !sent_successfully && !task.dest_canvas && !task.dest_dm && !task.dest_public_post {
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
    if task.dest_dm {
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
