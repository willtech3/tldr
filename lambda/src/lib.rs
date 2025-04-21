use thiserror::Error;
use slack_morphism::prelude::*;
use slack_morphism::{
    SlackApiToken, SlackApiTokenValue, 
    SlackChannelId, SlackUserId,
    SlackHistoryMessage,
    SlackMessageContent,
    SlackTs,
};
use slack_morphism::events::SlackMessageEventType;
use slack_morphism::hyper_tokio::{SlackHyperClient, SlackClientHyperConnector};
use openai_api_rs::v1::{
    api::Client as OpenAIClient, 
    chat_completion::{self, ChatCompletionRequest, ChatCompletionMessage, MessageRole}
};
use anyhow::Result;
use std::env;
use tracing::{error, info};
use reqwest::Client;

pub mod slack_parser;

#[derive(Debug, Error)]
pub enum SlackError {
    #[error("Failed to parse Slack event: {0}")]
    ParseError(String),
    
    #[error("Failed to access Slack API: {0}")]
    ApiError(String),
    
    #[error("Failed to access OpenAI API: {0}")]
    OpenAIError(String),
    
    #[error("Failed to send HTTP request: {0}")]
    HttpError(String),
    
    #[error("Failed to interact with AWS services: {0}")]
    AwsError(String),
}

impl From<slack_morphism::errors::SlackClientError> for SlackError {
    fn from(error: slack_morphism::errors::SlackClientError) -> Self {
        SlackError::ApiError(error.to_string())
    }
}

impl From<reqwest::Error> for SlackError {
    fn from(error: reqwest::Error) -> Self {
        SlackError::HttpError(error.to_string())
    }
}

impl From<anyhow::Error> for SlackError {
    fn from(error: anyhow::Error) -> Self {
        SlackError::ApiError(error.to_string())
    }
}

// Generic implementation for AWS SDK errors
impl<E> From<aws_sdk_sqs::types::SdkError<E>> for SlackError 
where 
    E: std::fmt::Display
{
    fn from(error: aws_sdk_sqs::types::SdkError<E>) -> Self {
        SlackError::AwsError(error.to_string())
    }
}

// HTTP Client implementation
pub struct HttpClient {
    client: Client,
}

impl HttpClient {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("Failed to create HTTP client"),
        }
    }

    pub fn post(&self, url: &str) -> reqwest::RequestBuilder {
        self.client.post(url)
    }
}

// Common Slack functionality
pub struct SlackBot {
    client: SlackHyperClient,
    token: SlackApiToken,
    openai_client: OpenAIClient,
}

impl SlackBot {
    pub async fn new() -> Result<Self, SlackError> {
        let token = env::var("SLACK_BOT_TOKEN")
            .map_err(|_| SlackError::ApiError("SLACK_BOT_TOKEN not found".to_string()))?;
        let openai_api_key = env::var("OPENAI_API_KEY")
            .map_err(|_| SlackError::OpenAIError("OPENAI_API_KEY not found".to_string()))?;
        
        let client = SlackHyperClient::new(SlackClientHyperConnector::new()); 
        let token = SlackApiToken::new(SlackApiTokenValue::new(token));
        let openai_client = OpenAIClient::new(openai_api_key); 
        
        Ok(Self { client, token, openai_client })
    }
    
    pub async fn get_user_im_channel(&self, user_id: &str) -> Result<String, SlackError> {
        let session = self.client.open_session(&self.token);
        let open_req = SlackApiConversationsOpenRequest::new()
            .with_users(vec![SlackUserId(user_id.to_string())]);
        
        let open_resp = session.conversations_open(&open_req).await?;
        Ok(open_resp.channel.id.0)
    }
    
    pub async fn get_unread_messages(&self, channel_id: &str) -> Result<Vec<SlackHistoryMessage>, SlackError> {
        let session = self.client.open_session(&self.token);
        
        let info_req = SlackApiConversationsInfoRequest::new(SlackChannelId(channel_id.to_string()));
        let channel_info = session.conversations_info(&info_req).await?;
        let last_read_ts = channel_info.channel.last_state.last_read.unwrap_or_else(|| SlackTs::new("0.0".into()));

        let request = SlackApiConversationsHistoryRequest::new()
            .with_channel(SlackChannelId(channel_id.to_string()))
            .with_limit(1000)
            .with_oldest(last_read_ts);
        
        let result = session.conversations_history(&request).await?;
        
        // Capture original length before moving
        let original_message_count = result.messages.len();
        
        // Filter messages: Keep only those from users and exclude common system messages
        let filtered_messages: Vec<SlackHistoryMessage> = result.messages.into_iter().filter(|msg| {
            // Check if the sender is a user (not a bot or system)
            let is_user_message = msg.sender.user.is_some();
            
            // Check for common system subtypes to exclude (add more as needed)
            let is_system_message = match &msg.subtype {
                Some(subtype) => matches!(
                    subtype,
                    SlackMessageEventType::ChannelJoin | SlackMessageEventType::ChannelLeave | SlackMessageEventType::BotMessage
                    // Add other subtypes like SlackMessageEventType::FileShare etc. if desired
                ),
                None => false, // Regular message, no subtype
            };
            
            is_user_message && !is_system_message
        }).collect();
        
        info!("Fetched {} total messages, filtered down to {} user messages for summarization", original_message_count, filtered_messages.len());
        
        Ok(filtered_messages)
    }
    
    pub async fn summarize_messages_with_chatgpt(&self, messages: &[SlackHistoryMessage]) -> Result<String, SlackError> {
        if messages.is_empty() {
            return Ok("No messages to summarize.".to_string());
        }
        
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

        let summary = result.choices
            .get(0)
            .and_then(|choice| choice.message.content.clone())
            .unwrap_or_else(|| "Could not generate summary.".to_string());

        Ok(summary)
    }
    
    pub async fn send_dm(&self, user_id: &str, message: &str) -> Result<(), SlackError> {
        info!("Attempting to get/open IM channel for user: {}", user_id);
        let channel_id = self.get_user_im_channel(user_id).await?;
        info!("Obtained IM channel ID: {} for user: {}", channel_id, user_id);
        
        let session = self.client.open_session(&self.token);
        let post_req = SlackApiChatPostMessageRequest::new(
            channel_id.clone().into(), 
            SlackMessageContent::new().with_text(message.to_string())
        );
        
        // Log before sending
        info!(channel = %channel_id, message_preview = %message.chars().take(50).collect::<String>(), "Attempting to send DM");

        // Use '?' to rely on SlackClientError conversion
        let response = session.chat_post_message(&post_req).await?;

        // Log after successful call (according to the library)
        info!(channel = %channel_id, ts = %response.ts, "Successfully posted message to Slack API (ts: {})", response.ts);
        
        Ok(())
    }
}
