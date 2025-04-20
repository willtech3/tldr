use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use tracing::{info, error};
use anyhow::Result;
use reqwest::Client as HttpClient;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use slack_morphism::prelude::*;
use slack_morphism::{
    SlackApiToken, SlackApiTokenValue, 
    SlackChannelId, 
    SlackHistoryMessage,
};
use slack_morphism::hyper_tokio::{SlackHyperClient, SlackClientHyperConnector};
use openai_api_rs::v1::{
    api::Client, 
    chat_completion::{self, ChatCompletionRequest, ChatCompletionMessage, MessageRole}
};

// Import shared module
use tldr::SlackError;

#[derive(Debug, Serialize, Deserialize)]
struct ProcessingTask {
    user_id: String,
    channel_id: String,
    response_url: String,
    text: String,
}

struct BotHandler {
    slack_client: SlackHyperClient,
    slack_token: SlackApiToken,
    openai_client: Client,
    http_client: HttpClient,
}

impl BotHandler {
    async fn new() -> Result<Self> {
        let token = env::var("SLACK_BOT_TOKEN")
            .map_err(|_| SlackError::ApiError("SLACK_BOT_TOKEN not found".to_string()))?;
        let openai_api_key = env::var("OPENAI_API_KEY")
            .map_err(|_| SlackError::OpenAIError("OPENAI_API_KEY not found".to_string()))?;
        
        // Initialize Slack client
        let slack_client = SlackHyperClient::new(SlackClientHyperConnector::new()); 
        let slack_token = SlackApiToken::new(SlackApiTokenValue::new(token));
        
        // Initialize OpenAI client
        let openai_client = Client::new(openai_api_key); 
        
        // Initialize HTTP client for response_url
        let http_client = HttpClient::new();
        
        Ok(Self { 
            slack_client, 
            slack_token, 
            openai_client,
            http_client,
        })
    }
    
    async fn get_unread_messages(&self, channel_id: &str) -> Result<Vec<SlackHistoryMessage>> {
        let session = self.slack_client.open_session(&self.slack_token);
        
        // Get channel info to find last read timestamp
        let info_req = SlackApiConversationsInfoRequest::new(SlackChannelId(channel_id.to_string()));
        let channel_info = session.conversations_info(&info_req).await?;

        // Get last_read timestamp
        let last_read_ts = channel_info.channel.last_state.last_read.unwrap_or_else(|| SlackTs::new("0.0".into()));

        // Get messages since last read
        let request = SlackApiConversationsHistoryRequest::new()
            .with_channel(SlackChannelId(channel_id.to_string()))
            .with_limit(1000)
            .with_oldest(last_read_ts);
        
        let result = session.conversations_history(&request).await?;
        Ok(result.messages)
    }
    
    async fn summarize_messages_with_chatgpt(&self, messages: &[SlackHistoryMessage]) -> Result<String> {
        if messages.is_empty() {
            return Ok("No messages to summarize.".to_string());
        }
        
        // Format messages for OpenAI
        let mut formatted_messages = Vec::new();
        for msg in messages { 
            let author = msg.sender.user.as_ref()
                .map_or("Unknown User", |uid| uid.as_ref());
            let ts = msg.origin.ts.clone(); 
            let text = msg.content.text.as_deref().unwrap_or("");
            
            formatted_messages.push(format!(
                "[{}] {}: {}", 
                ts, author, text
            ));
        }
        
        let prompt = format!(
            "Summarize the following Slack messages concisely:\n\n{}",
            formatted_messages.join("\n")
        );

        // Use the OpenAI client
        let chat_req = ChatCompletionRequest {
            model: chat_completion::GPT3_5_TURBO.to_string(),
            messages: vec![ChatCompletionMessage {
                role: MessageRole::user,
                content: prompt, 
                name: None,
                function_call: None,
            }],
            functions: None,
            function_call: None,
            temperature: Some(0.3),
            top_p: None,
            n: None,
            stream: None,
            stop: None,
            max_tokens: Some(2500),
            presence_penalty: None,
            frequency_penalty: None,
            logit_bias: None,
            user: None,
        };

        let result = self.openai_client.chat_completion(chat_req).await
            .map_err(|e| SlackError::OpenAIError(format!("OpenAI API error: {}", e)))?;

        // Extract the summary from the response
        let summary = result.choices
            .get(0)
            .and_then(|choice| choice.message.content.clone())
            .unwrap_or_else(|| "Could not generate summary.".to_string());

        Ok(summary)
    }
    
    async fn get_user_im_channel(&self, user_id: &str) -> Result<String> {
        let session = self.slack_client.open_session(&self.slack_token);

        // Use conversations.open to get or create IM channel
        let open_req = SlackApiConversationsOpenRequest::new()
            .with_users(vec![SlackUserId(user_id.to_string())]);
        
        let open_resp = session.conversations_open(&open_req).await?;
        Ok(open_resp.channel.id.0)
    }
    
    async fn send_dm(&self, user_id: &str, message: &str) -> Result<()> {
        let channel_id = self.get_user_im_channel(user_id).await?;
        let session = self.slack_client.open_session(&self.slack_token);
        let post_req = SlackApiChatPostMessageRequest::new(
            channel_id.into(), 
            SlackMessageContent::new().with_text(message.to_string())
        );
        session.chat_post_message(&post_req).await?;
        Ok(())
    }
    
    async fn send_response_url(&self, response_url: &str, message: &str) -> Result<()> {
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
    
    async fn process_task(&self, task: ProcessingTask) -> Result<()> {
        info!("Processing task for user {} in channel {}", task.user_id, task.channel_id);
        
        // Get unread messages
        match self.get_unread_messages(&task.channel_id).await {
            Ok(messages) => {
                if messages.is_empty() {
                    // No unread messages to summarize
                    self.send_response_url(&task.response_url, "No unread messages found in this channel.").await?;
                    return Ok(());
                }
                
                // Generate summary
                match self.summarize_messages_with_chatgpt(&messages).await {
                    Ok(summary) => {
                        // Send summary as DM
                        if let Err(e) = self.send_dm(&task.user_id, &summary).await {
                            error!("Failed to send DM: {}", e);
                            // Try to notify the user via response_url as fallback
                            self.send_response_url(
                                &task.response_url, 
                                "I was unable to send you a DM with the summary. Please check your DM settings."
                            ).await?;
                        } else {
                            // Update the user via response_url that the summary was sent
                            self.send_response_url(
                                &task.response_url, 
                                &format!("Summary of {} messages has been sent to your DMs!", messages.len())
                            ).await?;
                        }
                    },
                    Err(e) => {
                        error!("Failed to generate summary: {}", e);
                        self.send_response_url(
                            &task.response_url, 
                            "I was unable to generate a summary at this time. Please try again later."
                        ).await?;
                    }
                }
            },
            Err(e) => {
                error!("Failed to get unread messages: {}", e);
                self.send_response_url(
                    &task.response_url, 
                    "I was unable to fetch messages from this channel. Please try again later."
                ).await?;
            }
        }
        
        Ok(())
    }
}

async fn function_handler(event: LambdaEvent<Value>) -> Result<(), Error> {
    // Extract SQS message from event
    let records = event.payload["Records"].as_array()
        .ok_or_else(|| Error::from("Invalid SQS event: missing Records array"))?;
    
    if records.is_empty() {
        return Ok(()); // No records to process
    }
    
    // Initialize bot handler
    let bot_handler = BotHandler::new().await.map_err(|e| {
        error!("Failed to initialize bot handler: {}", e);
        Error::from(format!("Bot initialization error: {}", e))
    })?;
    
    // Process each record
    for record in records {
        let body = record["body"].as_str()
            .ok_or_else(|| Error::from("Invalid SQS record: missing body"))?;
        
        // Parse the task
        let task: ProcessingTask = serde_json::from_str(body)
            .map_err(|e| Error::from(format!("Failed to parse task: {}", e)))?;
        
        // Process the task
        if let Err(e) = bot_handler.process_task(task).await {
            error!("Error processing task: {}", e);
            // Continue with other records even if one fails
        }
    }
    
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    // Initialize tracing
    tracing_subscriber::fmt::init();
    
    // Run the Lambda function
    run(service_fn(function_handler)).await
}
