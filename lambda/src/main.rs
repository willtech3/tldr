use anyhow::Result;
use html2text::from_read as html_to_text;
use lambda_runtime::{Error, LambdaEvent, run, service_fn};
use openai_api_rs::v1::common::GPT4_O;
use openai_api_rs::v1::{
    api::OpenAIClient,
    chat_completion::{
        self, ChatCompletionMessageForResponse, ChatCompletionRequest, Content, ContentType,
        FinishReason, ImageUrl, ImageUrlType, MessageRole,
    },
    types::{Function, FunctionParameters, JSONSchemaDefine, JSONSchemaType},
};
use serde::Serialize;
use serde_json::Value;
use slack_morphism::hyper_tokio::{SlackClientHyperConnector, SlackHyperClient};
use slack_morphism::prelude::*;
use slack_morphism::{
    SlackApiToken, SlackApiTokenValue, SlackChannelId, SlackHistoryMessage, SlackUserId,
};
use std::env;
use tracing::{error, info};

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
        let openai_client = match OpenAIClient::builder().with_api_key(openai_api_key).build() {
            Ok(client) => client,
            Err(e) => return Err(anyhow::anyhow!("Failed to create OpenAI client: {}", e)),
        };

        Ok(Self {
            client,
            token,
            openai_client,
        })
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
        let info_req =
            SlackApiConversationsInfoRequest::new(SlackChannelId(channel_id.to_string()));
        let channel_info = session.conversations_info(&info_req).await?;

        // Correct path to last_read
        let last_read_ts = channel_info
            .channel
            .last_state
            .last_read
            .unwrap_or_else(|| SlackTs::new("0.0".into()));

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
        channel_id: &str,
        custom_prompt: Option<&str>,
    ) -> Result<String, SlackError> {
        if messages.is_empty() {
            return Ok("No messages to summarize.".to_string());
        }

        // Get channel name from channel_id
        let channel_info = self
            .client
            .open_session(&self.token)
            .conversations_info(&SlackApiConversationsInfoRequest::new(SlackChannelId::new(
                channel_id.to_string(),
            )))
            .await
            .map_err(|e| SlackError::OpenAI(format!("Failed to get channel info: {}", e)))?;

        let channel_name = channel_info
            .channel
            .name
            .unwrap_or_else(|| channel_id.to_string());

        // Build chat completion messages including text and images
        let mut chat_messages: Vec<chat_completion::ChatCompletionMessage> = Vec::new();

        // System prompt for the assistant
        chat_messages.push(chat_completion::ChatCompletionMessage {
            role: MessageRole::system,
            content: Content::Text(format!(
                "You are a helpful assistant that summarizes Slack conversations from channel '{}' for the user. \
Focus on key information, group related points, and preserve any useful links.",
                channel_name
            )),
            name: None,
            tool_calls: None,
            tool_call_id: None,
        });

        // Optional user-provided instructions (custom prompt)
        if let Some(extra) = custom_prompt {
            if !extra.trim().is_empty() {
                chat_messages.push(chat_completion::ChatCompletionMessage {
                    role: MessageRole::system, // keep it high-priority
                    content: Content::Text(extra.to_string()),
                    name: None,
                    tool_calls: None,
                    tool_call_id: None,
                });
            }
        }

        for msg in messages {
            // Author & timestamp
            let author = msg
                .sender
                .user
                .as_ref()
                .map_or("Unknown User", |uid| uid.as_ref());
            let ts = msg.origin.ts.clone();
            let text = msg.content.text.as_deref().unwrap_or("");

            // Add the plain text part of the message
            chat_messages.push(chat_completion::ChatCompletionMessage {
                role: MessageRole::user,
                content: Content::Text(format!("[{}] {}: {}", ts, author, text)),
                name: None,
                tool_calls: None,
                tool_call_id: None,
            });

            // Extract images from any attached files
            if let Some(files) = &msg.content.files {
                let mut imgs: Vec<ImageUrl> = Vec::new();
                for file in files {
                    if let Some(url) = &file.url_private {
                        imgs.push(ImageUrl {
                            r#type: ContentType::image_url,
                            text: None,
                            image_url: Some(ImageUrlType {
                                url: url.to_string(),
                            }),
                        });
                    }
                }
                if !imgs.is_empty() {
                    info!(
                        "Adding {} image(s) from ts {} to context",
                        imgs.len(),
                        msg.origin.ts.as_ref()
                    );
                    chat_messages.push(chat_completion::ChatCompletionMessage {
                        role: MessageRole::user,
                        content: Content::ImageUrl(imgs),
                        name: None,
                        tool_calls: None,
                        tool_call_id: None,
                    });
                }
            }
        }

        // ---------------- Tool definition ----------------
        let url_prop = JSONSchemaDefine {
            schema_type: Some(JSONSchemaType::String),
            description: Some("HTTP or HTTPS URL to fetch".to_string()),
            ..Default::default()
        };

        let mut properties = std::collections::HashMap::new();
        properties.insert("url".to_string(), Box::new(url_prop));

        let get_url_content_tool = chat_completion::Tool {
            r#type: chat_completion::ToolType::Function,
            function: Function {
                name: "get_url_content".to_string(),
                description: Some("Retrieve raw textual content from a URL".to_string()),
                parameters: FunctionParameters {
                    schema_type: JSONSchemaType::Object,
                    properties: Some(properties),
                    required: Some(vec!["url".to_string()]),
                },
            },
        };

        let tools_def = vec![get_url_content_tool.clone()];

        let mut messages_history = chat_messages;

        let mut iterations = 0;
        let mut response = self
            .openai_client
            .chat_completion(
                ChatCompletionRequest::new(GPT4_O.to_string(), messages_history.clone())
                    .temperature(if custom_prompt.is_some() { 0.9 } else { 0.3 })
                    .max_tokens(2500)
                    .tools(tools_def.clone())
                    .tool_choice(chat_completion::ToolChoiceType::Auto),
            )
            .await
            .map_err(|e| SlackError::OpenAI(format!("OpenAI API error: {}", e)))?;

        loop {
            let choice = response
                .choices
                .first()
                .ok_or_else(|| SlackError::OpenAI("No choices in response".to_string()))?;

            match &choice.finish_reason {
                Some(FinishReason::tool_calls) => {
                    // Assistant message that triggers the tool(s)
                    messages_history.push(Self::convert_response_message(&choice.message));

                    if let Some(tool_calls) = &choice.message.tool_calls {
                        info!("OpenAI requested {} tool call(s)", tool_calls.len());
                        for tc in tool_calls {
                            let args_json = tc.function.arguments.as_deref().unwrap_or("{}");

                            let url_opt =
                                serde_json::from_str::<Value>(args_json).ok().and_then(|v| {
                                    v.get("url").and_then(|u| u.as_str().map(|s| s.to_string()))
                                });

                            let fetched = if let Some(url) = url_opt {
                                info!("Fetching URL requested by model: {}", url);
                                match self.fetch_url_content(&url).await {
                                    Ok(text) => {
                                        info!("Fetched {} ({} chars)", url, text.len());
                                        text
                                    }
                                    Err(e) => {
                                        error!("Failed to fetch {}: {}", url, e);
                                        format!("Failed to fetch {}: {}", url, e)
                                    }
                                }
                            } else {
                                "Invalid arguments for get_url_content".to_string()
                            };

                            // Tool-role message with the fetched content
                            info!(
                                "Inserting tool response for call_id {} ({} chars)",
                                tc.id,
                                fetched.len()
                            );
                            messages_history.push(chat_completion::ChatCompletionMessage {
                                role: MessageRole::tool,
                                content: Content::Text(fetched),
                                name: None,
                                tool_calls: None,
                                tool_call_id: Some(tc.id.clone()),
                            });
                        }
                    }

                    // Call the model again with updated history
                    response = self
                        .openai_client
                        .chat_completion(
                            ChatCompletionRequest::new(
                                GPT4_O.to_string(),
                                messages_history.clone(),
                            )
                            .temperature(if custom_prompt.is_some() { 0.9 } else { 0.3 })
                            .max_tokens(2500)
                            .tools(tools_def.clone())
                            .tool_choice(chat_completion::ToolChoiceType::Auto),
                        )
                        .await
                        .map_err(|e| SlackError::OpenAI(format!("OpenAI API error: {}", e)))?;

                    iterations += 1;
                    if iterations >= 3 {
                        break; // avoid infinite loops
                    }
                }
                _ => break,
            }
        }

        let summary_text = response
            .choices
            .first()
            .and_then(|choice| choice.message.content.clone())
            .unwrap_or_else(|| "Could not generate summary.".to_string());

        let formatted_summary = format!("*Summary from #{}*\n\n{}", channel_name, summary_text);

        Ok(formatted_summary)
    }

    /// Fetches the textual content of a web page and strips most HTML tags.
    async fn fetch_url_content(&self, url: &str) -> Result<String, SlackError> {
        // Only allow http/https schemes to avoid SSRF risks
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(SlackError::Http("Unsupported URL scheme".to_string()));
        }

        // Simple GET with timeout
        let resp = reqwest::Client::new()
            .get(url)
            .header(
                "User-Agent",
                "tldr-bot/0.1 (+https://github.com/willtech3/tldr)",
            )
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| SlackError::Http(format!("Request error: {}", e)))?;

        if !resp.status().is_success() {
            return Err(SlackError::Http(format!(
                "Non-success status: {}",
                resp.status()
            )));
        }

        let body = resp
            .text()
            .await
            .map_err(|e| SlackError::Http(format!("Read body error: {}", e)))?;

        // Convert HTML → plain text (width 80) and trim to 4000 chars to save tokens
        let text = html_to_text(body.as_bytes(), 80);
        let trimmed = if text.len() > 4000 {
            format!("{}…", &text[..4000])
        } else {
            text
        };

        Ok(trimmed)
    }

    async fn send_dm(&self, user_id: &str, message: &str) -> Result<()> {
        let channel_id = self.get_user_im_channel(user_id).await?;
        let session = self.client.open_session(&self.token);
        let post_req = SlackApiChatPostMessageRequest::new(
            channel_id.into(),
            SlackMessageContent::new().with_text(message.to_string()),
        );
        session.chat_post_message(&post_req).await?;
        Ok(())
    }

    async fn handle_slash_command(&self, command: SlackCommandEvent) -> Result<String> {
        let channel_id = command.channel_id.clone();
        let user_id = command.user_id.clone();

        // Extract potential custom prompt from command text
        let custom_prompt_opt: Option<String> = {
            let trimmed = command.text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        };

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
                if let Ok(summary) = bot
                    .summarize_messages_with_chatgpt(
                        &messages_vec,
                        channel_id.as_ref(),
                        custom_prompt_opt.as_deref(),
                    )
                    .await
                {
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
        Ok(format!(
            "Processing {} unread messages. I'll DM you a summary shortly!",
            messages_count
        ))
    }

    /// Converts a response message into a request-format message so it can be
    /// appended back to the conversation history.
    fn convert_response_message(
        resp: &ChatCompletionMessageForResponse,
    ) -> chat_completion::ChatCompletionMessage {
        let content = resp.content.as_ref().map_or_else(
            || Content::Text(String::new()),
            |c| Content::Text(c.clone()),
        );

        chat_completion::ChatCompletionMessage {
            role: resp.role.clone(),
            content,
            name: resp.name.clone(),
            tool_calls: resp.tool_calls.clone(),
            tool_call_id: None,
        }
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
