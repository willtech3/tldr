use lambda_runtime::{Error, LambdaEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{info, error};
use anyhow::Result;
use reqwest::Client as HttpClient;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};

// Import shared modules
use tldr::{SlackError, SlackBot};

#[derive(Debug, Serialize, Deserialize)]
struct ProcessingTask {
    user_id: String,
    channel_id: String,
    response_url: String,
    text: String,
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
    
    async fn send_response_url(&self, response_url: &str, message: &str) -> Result<(), SlackError> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        
        let body = serde_json::json!({
            "text": message,
            "response_type": "ephemeral"
        });
        
        self.http_client.post(response_url)
            .headers(headers)
            .json(&body)
            .send()
            .await?;
            
        Ok(())
    }
    
    async fn process_task(&self, task: ProcessingTask) -> Result<(), SlackError> {
        info!("Processing task for user {} in channel {}", task.user_id, task.channel_id);
        
        // Get unread messages
        match self.slack_bot.get_unread_messages(&task.channel_id).await {
            Ok(messages) => {
                if messages.is_empty() {
                    // No unread messages to summarize
                    self.send_response_url(&task.response_url, "No unread messages found in this channel.").await?;
                    return Ok(());
                }
                
                // Generate summary
                match self.slack_bot.summarize_messages_with_chatgpt(&messages).await {
                    Ok(summary) => {
                        // Send summary as DM
                        if let Err(e) = self.slack_bot.send_dm(&task.user_id, &summary).await {
                            error!("Failed to send DM: {}", e);
                            // Try to notify the user via response_url as fallback
                            self.send_response_url(
                                &task.response_url, 
                                "I had trouble sending you a DM. Please check your Slack settings."
                            ).await?;
                        } else {
                            // Confirm summary sent via response_url
                            self.send_response_url(
                                &task.response_url, 
                                "I've sent you a summary of the unread messages in this channel."
                            ).await?;
                        }
                    },
                    Err(e) => {
                        error!("Failed to generate summary: {}", e);
                        self.send_response_url(
                            &task.response_url, 
                            "Sorry, I couldn't generate a summary at this time. Please try again later."
                        ).await?;
                    }
                }
            },
            Err(e) => {
                error!("Failed to get unread messages: {}", e);
                self.send_response_url(
                    &task.response_url, 
                    "Sorry, I couldn't retrieve unread messages. Please try again later."
                ).await?;
            }
        }
        
        Ok(())
    }
}

pub use self::function_handler as handler;

pub async fn function_handler(event: LambdaEvent<Value>) -> Result<(), Error> {
    info!("Worker Lambda received SQS event payload: {:?}", event.payload);
    
    // Extract and parse the message body from the SQS event
    // SQS events contain a 'Records' array, each record has a 'body' field
    let task: ProcessingTask = event.payload["Records"]
        .as_array()
        .and_then(|records| records.get(0)) // Get the first record
        .and_then(|record| record.get("body")) // Get the body field
        .and_then(|body| body.as_str())      // Get body as a string
        .ok_or_else(|| Error::from("Failed to extract SQS message body"))
        .and_then(|body_str| {
            serde_json::from_str(body_str)
                .map_err(|e| Error::from(format!("Failed to parse SQS message body into ProcessingTask: {}", e)))
        })?;
    
    info!("Successfully parsed ProcessingTask: {:?}", task);

    // Create bot handler and process task
    let handler = BotHandler::new().await
        .map_err(|e| Error::from(format!("Failed to initialize bot: {}", e)))?;
    
    if let Err(e) = handler.process_task(task).await {
        error!("Error processing task: {}", e);
        return Err(Error::from(format!("Processing error: {}", e)));
    }
    
    Ok(())
}

// Remove the unused main function - bootstrap.rs is the entry point
