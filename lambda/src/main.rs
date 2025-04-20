use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde::{Serialize};
use slack_morphism::prelude::*;
use slack_morphism::{
    SlackApiToken, SlackApiTokenValue, 
    SlackChannelId, 
    SlackMessageContent,
    SlackUserId,
    SlackTs,
    SlackHistoryMessage,
};
use slack_morphism::hyper_tokio::{SlackHyperClient, SlackClientHyperConnector};
use openai_api_rs::v1::{api::Client, chat_completion::{self, ChatCompletionRequest, ChatCompletionMessage, MessageRole}};
use std::env;
use anyhow::Result;
use tracing::{info, error};

mod slack_parser;
use slack_parser::{SlackCommandEvent, parse_form_data};

#[derive(Debug, thiserror::Error)]
enum SlackError {
    #[error("Failed to parse Slack event: {0}")]
    ParseError(String),
    
    #[error("Failed to access Slack API: {0}")]
    ApiError(String),
    
    #[error("Failed to access OpenAI API: {0}")]
    OpenAIError(String),
}

struct SlackBot {
    client: SlackHyperClient,
    token: SlackApiToken,
    openai_client: Client,
}

impl SlackBot {
    async fn new() -> Result<Self> {
        let token = env::var("SLACK_BOT_TOKEN")
            .map_err(|_| SlackError::ApiError("SLACK_BOT_TOKEN not found".to_string()))?;
        let openai_api_key = env::var("OPENAI_API_KEY")
            .map_err(|_| SlackError::OpenAIError("OPENAI_API_KEY not found".to_string()))?;
        
        // Initialize SlackHyperClient correctly using the connector
        let client = SlackHyperClient::new(SlackClientHyperConnector::new()); 
        let token = SlackApiToken::new(SlackApiTokenValue::new(token));
        let openai_client = Client::new(openai_api_key.clone()); 
        
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
    
    async fn summarize_messages_with_chatgpt(&self, messages: &[SlackHistoryMessage]) -> Result<String> {
        if messages.is_empty() {
            return Ok("No messages to summarize.".to_string());
        }
        
        // Format messages for OpenAI using SlackHistoryMessage fields
        let mut formatted_messages = Vec::new();
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
            "Summarize the following Slack messages concisely:\n\n{}",
            formatted_messages.join("\n")
        );

        // Use the openai-api-rs client
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
            if let Ok(bot) = SlackBot::new().await {
                // Pass the cloned Vec<SlackHistoryMessage>
                if let Ok(summary) = bot.summarize_messages_with_chatgpt(&messages_vec).await { 
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
        Ok(format!("Processing {} unread messages. I'll DM you a summary shortly, summarizing your latest unread messages!", messages_count))
    }
}

fn parse_slack_event(payload: &str) -> Result<SlackCommandEvent, SlackError> {
    // Parse the form-encoded data that Slack sends for slash commands
    parse_form_data(payload)
        .map_err(|e| SlackError::ParseError(format!("Failed to parse form data: {}", e)))
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
