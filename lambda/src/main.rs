use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde::{Serialize};
use slack_morphism::prelude::*;
use slack_morphism::{
    SlackApiToken, SlackApiTokenValue, 
    SlackChannelId, 
    SlackUserId,
    SlackHistoryMessage,
};
use slack_morphism::hyper_tokio::{SlackHyperClient, SlackClientHyperConnector};
use openai_api_rs::v1::{
    api::OpenAIClient,
    chat_completion::{self, ChatCompletionRequest, Content, MessageRole}
};
use openai_api_rs::v1::common::GPT4_O;
use std::env;
use anyhow::Result;
use tracing::{info, error};

mod slack_parser;
use slack_parser::{SlackCommandEvent, parse_form_data};

#[derive(Debug)]
enum SlackError {
    #[allow(dead_code)]
    Parse(String),
    
    OpenAI(String),
    
    #[allow(dead_code)]
    Http(String),
    
    #[allow(dead_code)]
    Aws(String),
}

impl std::fmt::Display for SlackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SlackError::Parse(msg) => write!(f, "Failed to parse Slack event: {}", msg),
            SlackError::OpenAI(msg) => write!(f, "Failed to access OpenAI API: {}", msg),
            SlackError::Http(msg) => write!(f, "Failed to send HTTP request: {}", msg),
            SlackError::Aws(msg) => write!(f, "Failed to interact with AWS services: {}", msg),
        }
    }
}

impl std::error::Error for SlackError {}

struct SlackBot {
    client: SlackHyperClient,
    token: SlackApiToken,
    openai_client: OpenAIClient,
}

impl SlackBot {
    async fn new() -> Result<Self> {
        let token = env::var("SLACK_BOT_TOKEN")?;
        let openai_api_key = env::var("OPENAI_API_KEY")?;
        
        // Initialize SlackHyperClient correctly using the connector
        let client = SlackHyperClient::new(SlackClientHyperConnector::new()); 
        let token = SlackApiToken::new(SlackApiTokenValue::new(token));
        
        // Use the builder pattern and handle errors explicitly to avoid issues with Send/Sync constraints
        let openai_client = match OpenAIClient::builder()
            .with_api_key(openai_api_key)
            .build() {
                Ok(client) => client,
                Err(e) => return Err(anyhow::anyhow!("Failed to create OpenAI client: {}", e))
            };
        
        Ok(Self { client, token, openai_client })
    }
    
    async fn get_user_im_channel(&self, user_id: &str) -> Result<String> {
        let session = self.client.open_session(&self.token);

        // Use conversations.open directly. It will return the existing IM channel ID 
        // if one exists, or open a new one.
        let open_req = SlackApiConversationsOpenRequest::new()
            .with_users(vec![SlackUserId(user_id.to_string())]);
        
        let open_resp = session.conversations_open(&open_req).await?;

        // The response directly contains the channel ID (new or existing)
        Ok(open_resp.channel.id.0)
    }
    
    async fn get_unread_messages(&self, channel_id: &str) -> Result<Vec<SlackHistoryMessage>> {
        let session = self.client.open_session(&self.token);
        
        // Get channel info to find last read timestamp (might require different API call)
        let info_req = SlackApiConversationsInfoRequest::new(SlackChannelId(channel_id.to_string()));
        let channel_info = session.conversations_info(&info_req).await?;

        // Correct path to last_read
        let last_read_ts = channel_info.channel.last_state.last_read.unwrap_or_else(|| SlackTs::new("0.0".into()));

        // Get messages since last read
        let request = SlackApiConversationsHistoryRequest::new()
            .with_channel(SlackChannelId(channel_id.to_string())) // Use builder method
            .with_limit(1000) // Adjust as needed
            .with_oldest(last_read_ts); // Pass SlackTs directly, not Option<SlackTs>
        
        let result = session.conversations_history(&request).await?;

        // Change return type to Vec<SlackHistoryMessage>
        Ok(result.messages)
    }
    
    async fn summarize_messages_with_chatgpt(
        &mut self, 
        messages: &[SlackHistoryMessage],
        channel_id: &str
    ) -> Result<String, SlackError> {
        if messages.is_empty() {
            return Ok("No messages to summarize.".to_string());
        }
        
        // Format messages for OpenAI using SlackHistoryMessage fields
        let mut formatted_messages = Vec::new();
        
        // Get channel name from channel_id
        let channel_info = self.client.open_session(&self.token)
            .conversations_info(&SlackApiConversationsInfoRequest::new(SlackChannelId::new(channel_id.to_string())))
            .await
            .map_err(|e| SlackError::OpenAI(format!("Failed to get channel info: {}", e)))?;
            
        let channel_name = channel_info.channel.name
            .unwrap_or_else(|| channel_id.to_string());
            
        for msg in messages { 
            // Access user via sender field as hinted by compiler
            let author = msg.sender.user.as_ref()
                .map_or("Unknown User", |uid| uid.as_ref());

            // Access ts via origin field as hinted by compiler
            let ts = msg.origin.ts.clone(); 
            // Access text via content field as hinted by compiler
            let text = msg.content.text.as_deref().unwrap_or("");
            
            formatted_messages.push(format!(
                "[{}] {}: {}", 
                ts, author, text
            ));
        }
        
        let prompt = format!(
            "Summarize the following Slack messages from channel '{}' in a clear, readable format. Include links from inputs where applicable. Focus on key information and organize by topics or threads where appropriate:\n\n{}",
            channel_name,
            formatted_messages.join("\n")
        );

        let chat_req = ChatCompletionRequest::new(
            GPT4_O.to_string(),
            vec![chat_completion::ChatCompletionMessage {
                role: MessageRole::user,
                content: Content::Text(prompt),
                name: None,
                tool_calls: None,
                tool_call_id: None,
            }]
        )
        .temperature(0.3)
        .max_tokens(2500);

        let result = match self.openai_client.chat_completion(chat_req).await {
            Ok(result) => result,
            Err(e) => return Err(SlackError::OpenAI(format!("OpenAI API error: {}", e)))
        };

        let summary = result.choices
            .first()
            .and_then(|choice| choice.message.content.clone())
            .unwrap_or_else(|| "Could not generate summary.".to_string());
            
        // Include channel information in the final summary
        let formatted_summary = format!("*Summary from #{}*\n\n{}", channel_name, summary);

        Ok(formatted_summary)
    }
    
    async fn send_dm(&self, user_id: &str, message: &str) -> Result<()> {
        let channel_id = self.get_user_im_channel(user_id).await?;
        let session = self.client.open_session(&self.token);
        let post_req = SlackApiChatPostMessageRequest::new(channel_id.into(), SlackMessageContent::new().with_text(message.to_string()));
        session.chat_post_message(&post_req).await?;
        Ok(())
    }
    
    async fn handle_slash_command(&self, command: SlackCommandEvent) -> Result<String> {
        let channel_id = command.channel_id.clone();
        let user_id = command.user_id.clone();
        
        // Type signature now returns Vec<SlackHistoryMessage>
        let messages = self.get_unread_messages(channel_id.as_ref()).await?;
        
        if messages.is_empty() {
            return Ok("No unread messages found in this channel.".to_string());
        }
        
        // Start async processing to generate summary and send DM
        let messages_count = messages.len(); // Store length before move
        let messages_vec = messages.to_vec(); // Clone messages for the async task if needed

        tokio::spawn(async move {
            if let Ok(mut bot) = SlackBot::new().await {
                // Pass the cloned Vec<SlackHistoryMessage>
                if let Ok(summary) = bot.summarize_messages_with_chatgpt(&messages_vec, channel_id.as_ref()).await { 
                    if let Err(e) = bot.send_dm(&user_id, &summary).await {
                        error!("Failed to send DM: {}", e);
                    } else {
                        info!("Summary DM sent successfully to {}", &user_id);
                    }
                } else {
                    error!("Failed to generate summary for user {}", &user_id);
                }
            } else {
                error!("Failed to create bot instance for async task.");
            }
        });

        // Acknowledge command immediately using the stored count
        Ok(format!("Processing {} unread messages. I'll DM you a summary shortly!", messages_count))
    }
}

fn parse_slack_event(payload: &str) -> Result<SlackCommandEvent, SlackError> {
    // Parse the form-encoded data that Slack sends for slash commands
    parse_form_data(payload)
        .map_err(|e| SlackError::Parse(format!("Failed to parse form data: {}", e)))
}

async fn function_handler(event: LambdaEvent<String>) -> Result<impl Serialize, Error> {
    let payload = event.payload;
    info!("Received request: {:?}", payload);

    let bot = SlackBot::new().await.map_err(|e| {
        error!("Failed to initialize bot: {}", e);
        Error::from(format!("Bot Initialization Error: {}", e))
    })?;

    // Parse the incoming event (now properly handles form data)
    let slack_event = parse_slack_event(&payload).map_err(|e| {
        error!("Failed to parse Slack event: {}", e);
        Error::from(format!("Parse Error: {}", e))
    })?;

    // Handle command event
    match bot.handle_slash_command(slack_event).await {
        Ok(response) => {
            info!("Command handled successfully.");
            // Return response in the format Slack expects
            Ok(serde_json::json!({
                "response_type": "ephemeral",
                "text": response
            }))
        }
        Err(e) => {
            error!("Error handling command: {}", e);
            Ok(serde_json::json!({
                "response_type": "ephemeral",
                "text": format!("Error: {}", e)
            }))
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    run(service_fn(function_handler)).await
}
