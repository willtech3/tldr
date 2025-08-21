#![allow(clippy::struct_excessive_bools)]
#![allow(clippy::too_many_lines)]
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::uninlined_format_args)]
use anyhow::Result;
use lambda_runtime::{Error, LambdaEvent};
use reqwest::Client as HttpClient;
use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
use serde_json::Value;
use tracing::{error, info};

// Import shared modules
use tldr::features::{collect, deliver, summarize};
use tldr::{SlackBot, SlackError, create_ephemeral_payload, format_summary_message};

use tldr::core::config::AppConfig;
use tldr::core::models::ProcessingTask;

struct BotHandler {
    slack_bot: SlackBot,
    http_client: HttpClient,
    config: AppConfig,
}

impl BotHandler {
    async fn new(config: &AppConfig) -> Result<Self, SlackError> {
        let slack_bot = SlackBot::new(config).await?;
        let http_client = HttpClient::new();

        Ok(Self {
            slack_bot,
            http_client,
            config: config.clone(),
        })
    }

    async fn send_response_url(
        &self,
        response_url: &str,
        message: &str,
        dm_fallback_user: Option<&str>,
    ) -> Result<(), SlackError> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        // Use the extracted function to create a consistent ephemeral payload
        let body = create_ephemeral_payload(message);

        let resp = self
            .http_client
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

            // Try DM fallback if provided
            if let Some(user_id) = dm_fallback_user {
                let _ = deliver::send_dm(&self.slack_bot, user_id, message)
                    .await
                    .map_err(|dm_err| {
                        error!("DM fallback failed for user {}: {}", user_id, dm_err);
                    });
            }
        }

        Ok(())
    }

    async fn process_task(&mut self, task: ProcessingTask) -> Result<(), SlackError> {
        info!(
            "Processing task correlation_id={} for user {} in channel {}",
            task.correlation_id, task.user_id, task.channel_id
        );

        // Determine channel to get messages from (always the original channel)
        let source_channel_id = &task.channel_id;

        // Get messages based on the parameters
        let mut messages = if let Some(count) = task.message_count {
            // If count is specified, always get the last N messages regardless of read/unread status
            collect::get_last_n_messages(&self.slack_bot, source_channel_id, count).await?
        } else {
            // If no count specified, default to unread messages (traditional behavior)
            collect::get_unread_messages(&self.slack_bot, source_channel_id).await?
        };

        // If visible/public flag is used, filter out the bot's own messages
        // This prevents the bot's response from being included in the summary
        if task.visible || task.dest_public_post {
            // Get the bot's own user ID
            let bot_user_id = (self.slack_bot.get_bot_user_id().await).ok();

            // Filter out messages from the bot
            if let Some(bot_id) = bot_user_id {
                messages.retain(|msg| {
                    if let Some(user_id) = &msg.sender.user {
                        // Extract the string value from SlackUserId for proper comparison
                        user_id.0 != bot_id
                    } else {
                        true // Keep messages without user ID
                    }
                });
            }
        }

        if messages.is_empty() {
            // No messages to summarize
            let no_messages_text = "No messages found to summarize.";

            // Send notification based on destination preferences
            if task.dest_dm {
                let _ = deliver::send_dm(&self.slack_bot, &task.user_id, no_messages_text).await;
            } else if let Some(resp_url) = &task.response_url {
                self.send_response_url(resp_url, no_messages_text, Some(&task.user_id))
                    .await?;
            }
            return Ok(());
        }

        // Generate summary
        match summarize::summarize(
            &self.slack_bot,
            &self.config,
            &messages,
            source_channel_id,
            task.custom_prompt.as_deref(),
        )
        .await
        {
            Ok(summary) => {
                // Track if we've sent to at least one destination
                let mut sent_successfully = false;

                // Handle Canvas destination if requested
                if task.dest_canvas {
                    info!(
                        "Writing summary to Canvas for channel {}",
                        source_channel_id
                    );
                    // Create formatted summary for Canvas with timestamp in Central Time
                    let now = chrono::Utc::now().with_timezone(&chrono_tz::US::Central);
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
                    // Get user's display name for attribution
                    let user_name = match self.slack_bot.get_user_info(&task.user_id).await {
                        Ok(name) => name,
                        Err(_) => format!("<@{}>", task.user_id),
                    };

                    let canvas_content =
                        format!("{summary}\n\n*Summary by {user_name} using TLDR bot*");

                    if let Err(e) = deliver::deliver_to_canvas(
                        &self.slack_bot,
                        source_channel_id,
                        &heading,
                        &canvas_content,
                    )
                    .await
                    {
                        error!("Failed to update Canvas: {}", e);
                    } else {
                        info!(
                            "Successfully updated Canvas for channel {}",
                            source_channel_id
                        );
                        sent_successfully = true;
                    }
                }

                // Handle DM destination if requested
                if task.dest_dm {
                    info!("Sending summary via DM to user {}", task.user_id);
                    if let Err(e) = deliver::send_dm(&self.slack_bot, &task.user_id, &summary).await
                    {
                        error!("Failed to send DM: {}", e);
                    } else {
                        sent_successfully = true;
                    }
                }

                // Handle public post destination if requested
                if task.dest_public_post {
                    info!("Posting summary publicly to channel {}", source_channel_id);
                    let message_content = format_summary_message(
                        &task.user_id,
                        source_channel_id,
                        &task.text,
                        &summary,
                        true,
                    );

                    if let Err(e) = deliver::send_message_to_channel(
                        &self.slack_bot,
                        source_channel_id,
                        &message_content,
                    )
                    .await
                    {
                        error!("Failed to send public message: {}", e);
                    } else {
                        sent_successfully = true;
                    }
                }

                // Legacy support: handle target_channel if specified
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

                    if let Err(e) = deliver::send_message_to_channel(
                        &self.slack_bot,
                        target_channel,
                        &message_content,
                    )
                    .await
                    {
                        error!("Failed to send to target channel: {}", e);
                    } else {
                        sent_successfully = true;
                    }
                }

                // Legacy support: handle visible flag without dest_public_post
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

                    if let Err(e) = deliver::send_message_to_channel(
                        &self.slack_bot,
                        source_channel_id,
                        &message_content,
                    )
                    .await
                    {
                        error!("Failed to send legacy visible message: {}", e);
                    } else {
                        sent_successfully = true;
                    }
                }

                // If no destinations were selected or all failed, fall back to DM
                if !sent_successfully
                    && !task.dest_canvas
                    && !task.dest_dm
                    && !task.dest_public_post
                {
                    info!("No destinations selected or all failed, defaulting to DM");
                    if let Err(e) = deliver::send_dm(&self.slack_bot, &task.user_id, &summary).await
                    {
                        error!("Failed to send fallback DM: {}", e);
                        // Last resort: try response_url
                        if let Some(resp_url) = &task.response_url {
                            self.send_response_url(
                                resp_url,
                                "Sorry, I couldn't deliver the summary. Please try again.",
                                Some(&task.user_id),
                            )
                            .await?;
                        }
                    }
                }
            }
            Err(e) => {
                error!("Failed to generate summary: {}", e);
                let error_message =
                    "Sorry, I couldn't generate a summary at this time. Please try again later.";

                if task.dest_dm {
                    let _ = deliver::send_dm(&self.slack_bot, &task.user_id, error_message).await;
                } else if let Some(resp_url) = &task.response_url {
                    self.send_response_url(resp_url, error_message, Some(&task.user_id))
                        .await?;
                }
            }
        }

        Ok(())
    }
}

pub use self::function_handler as handler;

pub async fn function_handler(event: LambdaEvent<Value>) -> Result<(), Error> {
    let config = AppConfig::from_env().map_err(|e| {
        error!("Config error: {}", e);
        Error::from(e)
    })?;
    info!(
        "Worker Lambda received SQS event payload: {:?}",
        event.payload
    );

    // Extract and parse the message body from the SQS event using iterator chains
    // SQS events contain a 'Records' array, each record has a 'body' field
    let task: ProcessingTask = event
        .payload
        .get("Records")
        .and_then(|records| records.as_array())
        .and_then(|records| records.first()) // Get the first record
        .and_then(|record| record.get("body")) // Get the body field
        .and_then(|body| body.as_str()) // Get body as a string
        .ok_or_else(|| Error::from("Failed to extract SQS message body"))
        .and_then(|body_str| {
            serde_json::from_str(body_str).map_err(|e| {
                Error::from(format!(
                    "Failed to parse SQS message body into ProcessingTask: {}",
                    e
                ))
            })
        })?;

    info!("Successfully parsed ProcessingTask: {:?}", task);

    // Create bot handler and process task using proper question mark error propagation
    let mut handler = BotHandler::new(&config)
        .await
        .map_err(|e| Error::from(format!("Failed to initialize bot: {}", e)))?;

    handler
        .process_task(task)
        .await
        .map_err(|e| Error::from(format!("Processing error: {}", e)))?;

    Ok(())
}

#[tokio::main]
#[allow(dead_code)]
async fn main() -> Result<(), Error> {
    // Initialize JSON structured logging
    tldr::setup_logging();

    // Start the Lambda runtime
    lambda_runtime::run(lambda_runtime::service_fn(function_handler)).await?;

    Ok(())
}
