use crate::clients::{LlmClient, SlackClient};

// no direct slack_morphism types needed after refactor

// removed unused imports after refactor
use serde_json::Value;
use tracing::{error, info};

use crate::core::config::AppConfig;
use crate::errors::SlackError;
use crate::response::create_replace_original_payload;

// removed HTTP client; moved image and HTTP specifics to SlackClient/features

/// Common Slack functionality
pub struct SlackBot {
    slack_client: SlackClient,
    llm_client: LlmClient,
}

impl SlackBot {
    pub async fn new(config: &AppConfig) -> Result<Self, SlackError> {
        let slack_client = SlackClient::new(config.slack_bot_token.clone());
        let model = config
            .openai_model
            .clone()
            .unwrap_or_else(|| "gpt-5".to_string());
        let llm_client = LlmClient::new(
            config.openai_api_key.clone(),
            config.openai_org_id.clone(),
            model,
        );

        Ok(Self {
            slack_client,
            llm_client,
        })
    }

    /// Get a reference to the Slack client for Canvas operations
    pub fn slack_client(&self) -> &SlackClient {
        &self.slack_client
    }

    /// Get a reference to the LLM client
    pub fn llm_client(&self) -> &LlmClient {
        &self.llm_client
    }

    pub async fn get_user_im_channel(&self, user_id: &str) -> Result<String, SlackError> {
        self.slack_client.get_user_im_channel(user_id).await
    }

    /// Get the bot's own user ID for filtering purposes
    pub async fn get_bot_user_id(&self) -> Result<String, SlackError> {
        self.slack_client.get_bot_user_id().await
    }

    // deprecated: moved to features::collect::get_unread_messages

    pub async fn get_user_info(&self, user_id: &str) -> Result<String, SlackError> {
        self.slack_client.get_user_info(user_id).await
    }

    // deprecated: moved to features::collect::get_last_n_messages

    pub async fn send_dm(&self, user_id: &str, message: &str) -> Result<(), SlackError> {
        self.slack_client.send_dm(user_id, message).await
    }

    pub async fn send_message_to_channel(
        &self,
        channel_id: &str,
        message: &str,
    ) -> Result<(), SlackError> {
        self.slack_client.post_message(channel_id, message).await
    }

    /// Opens a Block Kit modal using Slack's `views.open` API.
    pub async fn open_modal(&self, trigger_id: &str, view: &Value) -> Result<(), SlackError> {
        self.slack_client.open_modal(trigger_id, view).await
    }

    pub async fn delete_message(&self, channel_id: &str, ts: &str) -> Result<(), SlackError> {
        match self.slack_client.delete_message(channel_id, ts).await {
            Ok(_) => {
                info!(
                    "Successfully deleted message with ts {} from channel {}",
                    ts, channel_id
                );
                Ok(())
            }
            Err(e) => {
                error!("Failed to delete message: {}", e);
                Err(e)
            }
        }
    }

    /// Hides a slash command invocation by replacing it with an empty message
    /// Uses Slack's response_url mechanism which allows modifying the original message
    pub async fn replace_original_message(
        &self,
        response_url: &str,
        text: Option<&str>,
    ) -> Result<(), SlackError> {
        let payload = create_replace_original_payload(text);
        self.slack_client
            .replace_original_message(response_url, payload)
            .await
            .map(|_| {
                info!("Successfully replaced original message via response_url");
            })
    }

    // removed: handled in features/summarize or via SlackClient public URLs

    // removed: use SlackClient::fetch_image_size via features where needed

    // removed: SlackClient::ensure_public_file_url; URL helpers; prompt building; summarize implementation
}

// removed: shared helper lives in utils::mime
