use crate::core::models::ProcessingTask;
use crate::{CanvasHelper, SlackBot, SlackError, create_ephemeral_payload, format_summary_message};
use reqwest::{
    Client as HttpClient,
    header::{CONTENT_TYPE, HeaderMap, HeaderValue},
};
use tracing::{error, info};

async fn send_response_url(
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
            let _ = slack_bot.send_dm(user_id, message).await.map_err(|e| {
                error!("DM fallback failed for user {}: {}", user_id, e);
            });
        }
    }

    Ok(())
}

/// Deliver a summary (or no-op) to the destinations specified in the task.
#[allow(clippy::too_many_lines)]
pub async fn deliver(
    bot: &SlackBot,
    http_client: &HttpClient,
    task: &ProcessingTask,
    summary: Option<String>,
) -> Result<(), SlackError> {
    match summary {
        None => {
            let no_messages_text = "No messages found to summarize.";
            if task.dest_dm {
                let _ = bot.send_dm(&task.user_id, no_messages_text).await;
            } else if let Some(resp_url) = &task.response_url {
                send_response_url(
                    http_client,
                    bot,
                    resp_url,
                    no_messages_text,
                    Some(&task.user_id),
                )
                .await?;
            }
            Ok(())
        }
        Some(summary) => {
            let source_channel_id = &task.channel_id;
            let mut sent_successfully = false;

            // Canvas destination
            if task.dest_canvas {
                info!(
                    "Writing summary to Canvas for channel {}",
                    source_channel_id
                );
                let canvas_helper = CanvasHelper::new(bot.slack_client());
                if let Ok(canvas_id) = canvas_helper.ensure_channel_canvas(source_channel_id).await
                {
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
                    let user_name = match bot.get_user_info(&task.user_id).await {
                        Ok(name) => name,
                        Err(_) => format!("<@{}>", task.user_id),
                    };
                    let canvas_content =
                        format!("{summary}\n\n*Summary by {user_name} using TLDR bot*");
                    if canvas_helper
                        .prepend_summary_section(&canvas_id, &heading, &canvas_content)
                        .await
                        .is_ok()
                    {
                        sent_successfully = true;
                    }
                }
            }

            // DM destination
            if task.dest_dm {
                info!("Sending summary via DM to user {}", task.user_id);
                if bot.send_dm(&task.user_id, &summary).await.is_ok() {
                    sent_successfully = true;
                }
            }

            // Public post destination
            if task.dest_public_post {
                info!("Posting summary publicly to channel {}", source_channel_id);
                let message_content = format_summary_message(
                    &task.user_id,
                    source_channel_id,
                    &task.text,
                    &summary,
                    true,
                );
                if bot
                    .send_message_to_channel(source_channel_id, &message_content)
                    .await
                    .is_ok()
                {
                    sent_successfully = true;
                }
            }

            // Legacy target_channel support
            if let Some(target_channel) = task
                .target_channel_id
                .as_ref()
                .filter(|tc| *tc != source_channel_id)
            {
                info!("Sending to target channel {}", target_channel);
                let message_content = format_summary_message(
                    &task.user_id,
                    source_channel_id,
                    &task.text,
                    &summary,
                    task.visible,
                );
                if bot
                    .send_message_to_channel(target_channel, &message_content)
                    .await
                    .is_ok()
                {
                    sent_successfully = true;
                }
            }

            // Legacy visible flag
            if task.visible && !task.dest_public_post && task.target_channel_id.is_none() {
                info!(
                    "Legacy visible flag: posting publicly to {}",
                    source_channel_id
                );
                let message_content = format_summary_message(
                    &task.user_id,
                    source_channel_id,
                    &task.text,
                    &summary,
                    true,
                );
                if bot
                    .send_message_to_channel(source_channel_id, &message_content)
                    .await
                    .is_ok()
                {
                    sent_successfully = true;
                }
            }

            // Fallback when nothing was delivered
            if !sent_successfully && !task.dest_canvas && !task.dest_dm && !task.dest_public_post {
                info!("No destinations selected or all failed, defaulting to DM");
                if bot.send_dm(&task.user_id, &summary).await.is_err() {
                    if let Some(resp_url) = &task.response_url {
                        send_response_url(
                            http_client,
                            bot,
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
    }
}

/// Deliver an error message when summarization fails.
pub async fn deliver_error(
    bot: &SlackBot,
    http_client: &HttpClient,
    task: &ProcessingTask,
    message: &str,
) -> Result<(), SlackError> {
    if task.dest_dm {
        let _ = bot.send_dm(&task.user_id, message).await;
    } else if let Some(resp_url) = &task.response_url {
        send_response_url(http_client, bot, resp_url, message, Some(&task.user_id)).await?;
    }
    Ok(())
}
