use anyhow::Result;
use lambda_runtime::{Error, LambdaEvent};
use reqwest::Client as HttpClient;
use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{error, info};

// Import shared modules
use tldr::{SlackBot, SlackError, create_ephemeral_payload, format_summary_message};

#[derive(Debug, Serialize, Deserialize)]
struct ProcessingTask {
    correlation_id: String,
    user_id: String,
    channel_id: String,
    response_url: Option<String>,
    text: String,
    message_count: Option<u32>,
    target_channel_id: Option<String>,
    custom_prompt: Option<String>,
    visible: bool,
}

struct BotHandler {
    slack_bot: SlackBot,
    http_client: HttpClient,
}

impl BotHandler {
    async fn new() -> Result<Self, SlackError> {
        let slack_bot = SlackBot::new().await?;
        let http_client = HttpClient::new();

        Ok(Self {
            slack_bot,
            http_client,
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
                let _ = self
                    .slack_bot
                    .send_dm(user_id, message)
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
            self.slack_bot
                .get_last_n_messages(source_channel_id, count)
                .await?
        } else {
            // If no count specified, default to unread messages (traditional behavior)
            self.slack_bot
                .get_unread_messages(source_channel_id)
                .await?
        };

        // If visible/public flag is used, filter out the bot's own messages
        // This prevents the bot's response from being included in the summary
        if task.visible {
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
            if let Some(resp_url) = &task.response_url {
                self.send_response_url(
                    resp_url,
                    "No messages found to summarize.",
                    Some(&task.user_id),
                )
                .await?;
            } else {
                // If no response_url, try DM directly
                let _ = self
                    .slack_bot
                    .send_dm(&task.user_id, "No messages found to summarize.")
                    .await;
            }
            return Ok(());
        }

        // Generate summary
        match self
            .slack_bot
            .summarize_messages_with_chatgpt(
                &messages,
                source_channel_id,
                task.custom_prompt.as_deref(),
            )
            .await
        {
            Ok(summary) => {
                // Determine where to send the summary
                if let Some(target_channel) = &task.target_channel_id {
                    // Use the library's format_summary_message function
                    let message_content = format_summary_message(
                        &task.user_id,
                        source_channel_id,
                        &task.text,
                        &summary,
                        task.visible,
                    );

                    // Send to the specified channel
                    if let Err(e) = self
                        .slack_bot
                        .send_message_to_channel(target_channel, &message_content)
                        .await
                    {
                        error!(
                            "Failed to send message to channel {}: {}",
                            target_channel, e
                        );
                        // Fallback to sending as DM
                        if let Err(dm_error) = self.slack_bot.send_dm(&task.user_id, &summary).await
                        {
                            error!("Failed to send DM as fallback: {}", dm_error);
                            if let Some(resp_url) = &task.response_url {
                                self
                                    .send_response_url(
                                        resp_url,
                                        "Sorry, I couldn't generate a summary at this time. Please try again later.",
                                        Some(&task.user_id)
                                    ).await?;
                            }
                        } else if let Some(resp_url) = &task.response_url {
                            self
                                .send_response_url(
                                    resp_url,
                                    "Sorry, I couldn't generate a summary at this time. Please try again later.",
                                    Some(&task.user_id)
                                ).await?;
                        }
                    } else {
                        // Do not send confirmation message when public post succeeds
                        // Otherwise, don't send a confirmation since the message is already visible
                    }
                } else {
                    // Check if we should post publicly to the current channel
                    if task.visible {
                        // Use the library's format_summary_message function
                        let message_content = format_summary_message(
                            &task.user_id,
                            source_channel_id,
                            &task.text,
                            &summary,
                            task.visible,
                        );

                        // Post summary directly to the channel (visible to all)
                        if let Err(e) = self
                            .slack_bot
                            .send_message_to_channel(source_channel_id, &message_content)
                            .await
                        {
                            error!(
                                "Failed to send public message to channel {}: {}",
                                source_channel_id, e
                            );
                            // Fallback to sending as DM
                            if let Err(dm_error) =
                                self.slack_bot.send_dm(&task.user_id, &summary).await
                            {
                                error!("Failed to send DM as fallback: {}", dm_error);
                                if let Some(resp_url) = &task.response_url {
                                    self
                                        .send_response_url(
                                            resp_url,
                                            "Sorry, I couldn't generate a summary at this time. Please try again later.",
                                            Some(&task.user_id)
                                        ).await?;
                                }
                            } else if let Some(resp_url) = &task.response_url {
                                self
                                    .send_response_url(
                                        resp_url,
                                        "Sorry, I couldn't generate a summary at this time. Please try again later.",
                                        Some(&task.user_id)
                                    ).await?;
                            }
                        }
                        // Intentionally not sending a confirmation message when visible message posts successfully
                        // This avoids redundant notifications when the message is already visible in the channel
                    } else {
                        // Send as DM to the user (original behavior)
                        if let Err(e) = self.slack_bot.send_dm(&task.user_id, &summary).await {
                            error!("Failed to send DM: {}", e);
                            // Try to notify the user via response_url as fallback
                            if let Some(resp_url) = &task.response_url {
                                self
                                    .send_response_url(
                                        resp_url,
                                        "Sorry, I couldn't generate a summary at this time. Please try again later.",
                                        Some(&task.user_id)
                                    )
                                    .await?;
                            }
                        } else {
                            // Do not send a confirmation when DM succeeds
                        }
                    }
                }
            }
            Err(e) => {
                error!("Failed to generate summary: {}", e);
                if let Some(resp_url) = &task.response_url {
                    self
                        .send_response_url(
                            resp_url,
                            "Sorry, I couldn't generate a summary at this time. Please try again later.",
                            Some(&task.user_id),
                        )
                        .await?;
                } else {
                    let _ = self.slack_bot.send_dm(&task.user_id, "Sorry, I couldn't generate a summary at this time. Please try again later.").await;
                }
            }
        }

        Ok(())
    }
}

pub use self::function_handler as handler;

pub async fn function_handler(event: LambdaEvent<Value>) -> Result<(), Error> {
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
    let mut handler = BotHandler::new()
        .await
        .map_err(|e| Error::from(format!("Failed to initialize bot: {}", e)))?;

    handler
        .process_task(task)
        .await
        .map_err(|e| Error::from(format!("Processing error: {}", e)))?;

    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    // Initialize JSON structured logging
    tldr::setup_logging();

    // Start the Lambda runtime
    lambda_runtime::run(lambda_runtime::service_fn(function_handler)).await?;

    Ok(())
}
