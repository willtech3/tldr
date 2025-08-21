use crate::errors::SlackError;
use crate::response::create_replace_original_payload;
use once_cell::sync::Lazy;
use reqwest::Client;
use serde_json::Value;
use slack_morphism::hyper_tokio::{SlackClientHyperConnector, SlackHyperClient};
use slack_morphism::prelude::*;
use slack_morphism::{SlackApiToken, SlackApiTokenValue};
use std::time::Duration;
use tokio_retry::{Retry, strategy::ExponentialBackoff, strategy::jitter};
use tracing::{error, info};

pub(crate) static SLACK_CLIENT: Lazy<SlackHyperClient> = Lazy::new(|| {
    SlackHyperClient::new(
        SlackClientHyperConnector::new().expect("Failed to create Slack client connector"),
    )
});

pub(crate) static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| Client::new())
});

/// Rough token estimation - assume ~4 characters per token for English-like text.
/// Adds 3 before division to effectively round up (ceiling).
pub fn estimate_tokens(text: &str) -> usize {
    text.chars().count() / 4 + 1
}

/// Common Slack functionality
pub struct SlackBot {
    pub(crate) token: SlackApiToken,
}

impl SlackBot {
    pub async fn new(config: &crate::core::config::AppConfig) -> Result<Self, SlackError> {
        let token = SlackApiToken::new(SlackApiTokenValue::new(config.slack_bot_token.clone()));
        Ok(Self { token })
    }

    /// Get a reference to the bot's token for Canvas operations
    pub fn token(&self) -> &SlackApiToken {
        &self.token
    }

    // Helper function to wrap API calls with retry logic for rate limits and server errors
    pub(crate) async fn with_retry<F, Fut, T>(&self, operation: F) -> Result<T, SlackError>
    where
        F: Fn() -> Fut + Send,
        Fut: std::future::Future<Output = Result<T, SlackError>> + Send,
        T: Send,
    {
        let strategy = ExponentialBackoff::from_millis(100).map(jitter).take(5);
        Retry::spawn(strategy, operation).await
    }

    pub async fn get_user_im_channel(&self, user_id: &str) -> Result<String, SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT.open_session(&self.token);
            let open_req = SlackApiConversationsOpenRequest::new()
                .with_users(vec![SlackUserId(user_id.to_string())]);
            let open_resp = session.conversations_open(&open_req).await?;
            Ok(open_resp.channel.id.0)
        })
        .await
    }

    /// Get the bot's own user ID for filtering purposes
    pub async fn get_bot_user_id(&self) -> Result<String, SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT.open_session(&self.token);
            let auth_test = session
                .auth_test()
                .await
                .map_err(|e| SlackError::ApiError(format!("Failed to get bot info: {}", e)))?;
            Ok(auth_test.user_id.0)
        })
        .await
    }

    pub async fn get_user_info(&self, user_id: &str) -> Result<String, SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT.open_session(&self.token);
            let user_info_req = SlackApiUsersInfoRequest::new(SlackUserId(user_id.to_string()));

            match session.users_info(&user_info_req).await {
                Ok(info) => {
                    let name = info
                        .user
                        .real_name
                        .or(info.user.profile.and_then(|p| p.display_name))
                        .unwrap_or_else(|| user_id.to_string());
                    Ok(if name.is_empty() {
                        user_id.to_string()
                    } else {
                        name
                    })
                }
                Err(e) => {
                    error!("Failed to get user info for {}: {}", user_id, e);
                    Ok(user_id.to_string())
                }
            }
        })
        .await
    }

    /// Opens a Block Kit modal using Slack's `views.open` API.
    pub async fn open_modal(&self, trigger_id: &str, view: &Value) -> Result<(), SlackError> {
        let payload = serde_json::json!({
            "trigger_id": trigger_id,
            "view": view
        });

        let resp = HTTP_CLIENT
            .post("https://slack.com/api/views.open")
            .bearer_auth(&self.token.token_value.0)
            .json(&payload)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(SlackError::ApiError(format!(
                "views.open HTTP {}",
                resp.status()
            )));
        }

        let json: Value = resp.json().await?;
        if json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            Ok(())
        } else {
            Err(SlackError::ApiError(format!(
                "views.open error: {}",
                json.get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("unknown")
            )))
        }
    }

    pub async fn delete_message(&self, channel_id: &str, ts: &str) -> Result<(), SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT.open_session(&self.token);
            let delete_req = SlackApiChatDeleteRequest::new(
                SlackChannelId::new(channel_id.to_string()),
                SlackTs::new(ts.to_string()),
            );

            match session.chat_delete(&delete_req).await {
                Ok(_) => {
                    info!(
                        "Successfully deleted message with ts {} from channel {}",
                        ts, channel_id
                    );
                    Ok(())
                }
                Err(e) => {
                    error!("Failed to delete message: {}", e);
                    Err(SlackError::ApiError(format!(
                        "Failed to delete message: {}",
                        e
                    )))
                }
            }
        })
        .await
    }

    /// Hides a slash command invocation by replacing it with an empty message
    /// Uses Slack's response_url mechanism which allows modifying the original message
    pub async fn replace_original_message(
        &self,
        response_url: &str,
        text: Option<&str>,
    ) -> Result<(), SlackError> {
        self.with_retry(|| async {
            let payload = create_replace_original_payload(text);

            let response = HTTP_CLIENT
                .post(response_url)
                .header("Content-Type", "application/json")
                .json(&payload)
                .send()
                .await
                .map_err(|e| SlackError::HttpError(format!("Failed to replace message: {}", e)))?;

            if !response.status().is_success() {
                let status = response.status();
                let body = response
                    .text()
                    .await
                    .unwrap_or_else(|_| String::from("Unable to read response body"));
                return Err(SlackError::ApiError(format!(
                    "Failed to replace message: HTTP {} - {}",
                    status, body
                )));
            }

            info!("Successfully replaced original message via response_url");
            Ok(())
        })
        .await
    }
}
