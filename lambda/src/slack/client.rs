//! Slack API client module
//!
//! Encapsulates all Slack API interactions with retry logic and error handling.

use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use slack_morphism::hyper_tokio::{SlackClientHyperConnector, SlackHyperClient};
use slack_morphism::prelude::{
    SlackApiChatDeleteRequest, SlackApiChatPostMessageRequest, SlackApiConversationsHistoryRequest,
    SlackApiConversationsInfoRequest, SlackApiConversationsOpenRequest, SlackApiUsersInfoRequest,
};
use slack_morphism::{
    SlackApiToken, SlackApiTokenValue, SlackChannelId, SlackFile, SlackHistoryMessage,
    SlackMessageContent, SlackTs, SlackUserId,
};
use std::time::Duration;
use tokio_retry::strategy::jitter;
use tokio_retry::{Retry, strategy::ExponentialBackoff};
use tracing::{info, warn};

use crate::errors::SlackError;

// Build the Slack client connector safely without panicking.
// If connector construction fails, store None and surface a SlackError at call sites.
static SLACK_CLIENT: std::sync::LazyLock<Option<SlackHyperClient>> =
    std::sync::LazyLock::new(|| match SlackClientHyperConnector::new() {
        Ok(connector) => Some(SlackHyperClient::new(connector)),
        Err(e) => {
            warn!("Failed to create Slack HTTP connector: {}", e);
            None
        }
    });

static HTTP_CLIENT: std::sync::LazyLock<Client> = std::sync::LazyLock::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| Client::new())
});

/// Canvas API response types
#[derive(Debug, Deserialize)]
struct CanvasCreateResponse {
    ok: bool,
    canvas_id: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CanvasEditResponse {
    ok: bool,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PermalinkResponse {
    ok: bool,
    permalink: Option<String>,
    error: Option<String>,
}

/// Slack API client with retry logic and error handling
pub struct SlackClient {
    token: SlackApiToken,
}

impl SlackClient {
    #[must_use]
    pub fn new(token: String) -> Self {
        Self {
            token: SlackApiToken::new(SlackApiTokenValue::new(token)),
        }
    }

    /// Build a Slack client that uses a user token for read operations.
    /// This is identical to `new` but named explicitly for clarity at call sites.
    #[must_use]
    pub fn from_user_token(user_token: String) -> Self {
        Self {
            token: SlackApiToken::new(SlackApiTokenValue::new(user_token)),
        }
    }

    #[must_use]
    pub fn token(&self) -> &SlackApiToken {
        &self.token
    }

    async fn with_retry<F, Fut, T>(&self, operation: F) -> Result<T, SlackError>
    where
        F: FnMut() -> Fut + Send,
        Fut: std::future::Future<Output = Result<T, SlackError>> + Send,
        T: Send,
    {
        let strategy = ExponentialBackoff::from_millis(100).map(jitter).take(5);

        Retry::spawn(strategy, operation).await
    }

    /// # Errors
    ///
    /// Returns an error if the Slack API call fails or response parsing fails.
    pub async fn get_user_im_channel(&self, user_id: &str) -> Result<String, SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT
                .as_ref()
                .ok_or_else(|| {
                    SlackError::GeneralError("Slack HTTP connector not initialized".to_string())
                })?
                .open_session(&self.token);
            let open_req = SlackApiConversationsOpenRequest::new()
                .with_users(vec![SlackUserId(user_id.to_string())]);

            let result = session.conversations_open(&open_req).await?;
            let channel_id = result.channel.id.0;
            Ok(channel_id)
        })
        .await
    }

    /// # Errors
    pub async fn get_bot_user_id(&self) -> Result<String, SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT
                .as_ref()
                .ok_or_else(|| {
                    SlackError::GeneralError("Slack HTTP connector not initialized".to_string())
                })?
                .open_session(&self.token);

            let test_resp = session.auth_test().await?;

            // user_id is directly a SlackUserId, not an Option
            Ok(test_resp.user_id.0)
        })
        .await
    }

    /// Get messages from channel since last read timestamp
    /// # Errors
    pub async fn get_unread_messages(
        &self,
        channel_id: &str,
    ) -> Result<Vec<SlackHistoryMessage>, SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT
                .as_ref()
                .ok_or_else(|| {
                    SlackError::GeneralError("Slack HTTP connector not initialized".to_string())
                })?
                .open_session(&self.token);

            // First get channel info to determine last_read timestamp
            let info_req =
                SlackApiConversationsInfoRequest::new(SlackChannelId(channel_id.to_string()));
            let channel_info = session.conversations_info(&info_req).await?;

            let last_read_ts = channel_info
                .channel
                .last_state
                .last_read
                .unwrap_or_else(|| {
                    // Fallback to 12 hours ago if no last_read
                    info!(
                        "last_read not present; falling back to ~12h window for channel {}",
                        channel_id
                    );
                    let twelve_hours_ago = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0)
                        .saturating_sub(12 * 3600);
                    SlackTs(format!("{twelve_hours_ago}.000000"))
                });

            // Get messages since last_read
            let request = SlackApiConversationsHistoryRequest::new()
                .with_channel(SlackChannelId(channel_id.to_string()))
                .with_oldest(last_read_ts)
                .with_limit(1000);

            let result = session.conversations_history(&request).await?;
            Ok(result.messages)
        })
        .await
    }

    /// Get messages from channel in the last 12 hours (for compatibility)
    /// # Errors
    pub async fn get_channel_history(
        &self,
        channel_id: &str,
    ) -> Result<Vec<SlackHistoryMessage>, SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT
                .as_ref()
                .ok_or_else(|| {
                    SlackError::GeneralError("Slack HTTP connector not initialized".to_string())
                })?
                .open_session(&self.token);

            let mut request = SlackApiConversationsHistoryRequest::new()
                .with_channel(SlackChannelId(channel_id.to_string()));

            let twelve_hours_ago = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
                - 12 * 3600;

            request = request.with_oldest(SlackTs(twelve_hours_ago.to_string()));

            let result = session.conversations_history(&request).await?;

            let messages = result.messages;

            Ok(messages)
        })
        .await
    }

    /// # Errors
    pub async fn get_user_info(&self, user_id: &str) -> Result<String, SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT
                .as_ref()
                .ok_or_else(|| {
                    SlackError::GeneralError("Slack HTTP connector not initialized".to_string())
                })?
                .open_session(&self.token);
            let user_info_req = SlackApiUsersInfoRequest::new(SlackUserId(user_id.to_string()));

            match session.users_info(&user_info_req).await {
                Ok(info) => {
                    let name = info
                        .user
                        .profile
                        .as_ref()
                        .and_then(|p| p.real_name.clone())
                        .or_else(|| {
                            info.user
                                .profile
                                .as_ref()
                                .and_then(|p| p.display_name.clone())
                        })
                        .unwrap_or_else(|| user_id.to_string());

                    Ok(name)
                }
                Err(e) => {
                    warn!("Failed to fetch user info for {}: {:?}", user_id, e);
                    Ok(user_id.to_string())
                }
            }
        })
        .await
    }

    /// # Errors
    pub async fn get_recent_messages(
        &self,
        channel_id: &str,
        count: u32,
    ) -> Result<Vec<SlackHistoryMessage>, SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT
                .as_ref()
                .ok_or_else(|| {
                    SlackError::GeneralError("Slack HTTP connector not initialized".to_string())
                })?
                .open_session(&self.token);

            let request = SlackApiConversationsHistoryRequest::new()
                .with_channel(SlackChannelId(channel_id.to_string()))
                .with_limit(u16::try_from(std::cmp::min(count, 1000)).unwrap_or(1000));

            let result = session.conversations_history(&request).await?;

            let messages = result.messages;

            Ok(messages)
        })
        .await
    }

    /// # Errors
    pub async fn send_dm(&self, user_id: &str, message: &str) -> Result<(), SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT
                .as_ref()
                .ok_or_else(|| {
                    SlackError::GeneralError("Slack HTTP connector not initialized".to_string())
                })?
                .open_session(&self.token);
            let im_channel = self.get_user_im_channel(user_id).await?;

            let post_req = SlackApiChatPostMessageRequest::new(
                SlackChannelId(im_channel),
                SlackMessageContent::new().with_text(message.to_string()),
            );

            session.chat_post_message(&post_req).await?;

            Ok(())
        })
        .await
    }

    /// # Errors
    pub async fn post_message(&self, channel_id: &str, message: &str) -> Result<(), SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT
                .as_ref()
                .ok_or_else(|| {
                    SlackError::GeneralError("Slack HTTP connector not initialized".to_string())
                })?
                .open_session(&self.token);

            let post_req = SlackApiChatPostMessageRequest::new(
                SlackChannelId(channel_id.to_string()),
                SlackMessageContent::new().with_text(message.to_string()),
            );

            session.chat_post_message(&post_req).await?;

            Ok(())
        })
        .await
    }

    /// Post a plain-text reply into a specific thread.
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTP request fails or Slack returns an error.
    pub async fn post_message_in_thread(
        &self,
        channel_id: &str,
        thread_ts: &str,
        message: &str,
    ) -> Result<(), SlackError> {
        let payload = json!({
            "channel": channel_id,
            "text": message,
            "thread_ts": thread_ts,
        });

        self.with_retry(|| async {
            let resp = HTTP_CLIENT
                .post("https://slack.com/api/chat.postMessage")
                .bearer_auth(&self.token.token_value.0)
                .json(&payload)
                .send()
                .await
                .map_err(|e| {
                    SlackError::GeneralError(format!("Failed to post thread message: {e}"))
                })?;

            if !resp.status().is_success() {
                return Err(SlackError::ApiError(format!(
                    "chat.postMessage HTTP {}",
                    resp.status()
                )));
            }

            let body: Value = resp.json().await.map_err(|e| {
                SlackError::GeneralError(format!("chat.postMessage JSON parse error: {e}"))
            })?;

            if !body.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                return Err(SlackError::ApiError(format!(
                    "chat.postMessage error: {}",
                    body.get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                )));
            }

            Ok(())
        })
        .await
    }

    /// # Errors
    pub async fn delete_message(&self, channel_id: &str, ts: &str) -> Result<(), SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT
                .as_ref()
                .ok_or_else(|| {
                    SlackError::GeneralError("Slack HTTP connector not initialized".to_string())
                })?
                .open_session(&self.token);

            let delete_req = SlackApiChatDeleteRequest::new(
                SlackChannelId(channel_id.to_string()),
                SlackTs(ts.to_string()),
            );

            session.chat_delete(&delete_req).await?;
            Ok(())
        })
        .await
    }

    /// # Errors
    pub async fn replace_original_message(
        &self,
        response_url: &str,
        payload: Value,
    ) -> Result<(), SlackError> {
        self.with_retry(|| async {
            let response = HTTP_CLIENT
                .post(response_url)
                .json(&payload)
                .send()
                .await
                .map_err(|e| SlackError::GeneralError(format!("HTTP request failed: {e}")))?;

            if !response.status().is_success() {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                return Err(SlackError::GeneralError(format!(
                    "Failed to update message: {status} - {text}"
                )));
            }

            Ok(())
        })
        .await
    }

    // Canvas-specific methods

    /// # Errors
    ///
    /// Returns an error if the Slack API request or response parsing fails.
    pub async fn get_channel_name(&self, channel_id: &str) -> Result<String, SlackError> {
        let info_payload = json!({
            "channel": channel_id,
        });

        let info_resp = HTTP_CLIENT
            .post("https://slack.com/api/conversations.info")
            .bearer_auth(&self.token.token_value.0)
            .json(&info_payload)
            .send()
            .await
            .map_err(|e| SlackError::GeneralError(format!("Failed to get channel info: {e}")))?;

        let info_data: Value = info_resp
            .json()
            .await
            .map_err(|e| SlackError::GeneralError(format!("Failed to parse channel info: {e}")))?;

        let channel_name = info_data
            .get("channel")
            .and_then(|c| c.get("name"))
            .and_then(|n| n.as_str())
            .map_or_else(|| channel_id.to_string(), std::string::ToString::to_string);

        Ok(channel_name)
    }

    /// # Errors
    ///
    /// Returns an error if the Slack API request or response parsing fails.
    pub async fn get_channel_canvas_id(
        &self,
        channel_id: &str,
    ) -> Result<Option<String>, SlackError> {
        let info_payload = json!({
            "channel": channel_id,
        });

        let info_resp = HTTP_CLIENT
            .post("https://slack.com/api/conversations.info")
            .bearer_auth(&self.token.token_value.0)
            .json(&info_payload)
            .send()
            .await
            .map_err(|e| SlackError::GeneralError(format!("Failed to get channel info: {e}")))?;

        let info_data: Value = info_resp
            .json()
            .await
            .map_err(|e| SlackError::GeneralError(format!("Failed to parse channel info: {e}")))?;

        let canvas_id_opt = info_data
            .get("channel")
            .and_then(|c| c.get("properties"))
            .and_then(|p| p.get("canvas"))
            .and_then(|c| c.get("id"))
            .and_then(|id| id.as_str())
            .map(std::string::ToString::to_string);

        Ok(canvas_id_opt)
    }

    /// # Errors
    ///
    /// Returns an error if the Slack API request or response parsing fails.
    pub async fn create_canvas(
        &self,
        channel_id: &str,
        content: &str,
    ) -> Result<String, SlackError> {
        let create_payload = json!({
            "channel_id": channel_id,
            "document_content": {
                "type": "markdown",
                "markdown": content,
            },
        });

        let resp = HTTP_CLIENT
            .post("https://slack.com/api/conversations.canvases.create")
            .bearer_auth(&self.token.token_value.0)
            .json(&create_payload)
            .send()
            .await
            .map_err(|e| {
                SlackError::GeneralError(format!("Canvas creation request failed: {e}"))
            })?;

        let create_resp: CanvasCreateResponse = resp.json().await.map_err(|e| {
            SlackError::GeneralError(format!("Failed to parse canvas creation response: {e}"))
        })?;

        if !create_resp.ok {
            return Err(SlackError::GeneralError(format!(
                "Canvas creation failed: {}",
                create_resp
                    .error
                    .unwrap_or_else(|| "Unknown error".to_string())
            )));
        }

        create_resp
            .canvas_id
            .ok_or_else(|| SlackError::GeneralError("No canvas ID in response".to_string()))
    }

    /// # Errors
    ///
    /// Returns an error if the Slack API request or response parsing fails.
    pub async fn insert_canvas_at_start(
        &self,
        canvas_id: &str,
        content: &str,
    ) -> Result<(), SlackError> {
        let edit_payload = json!({
            "canvas_id": canvas_id,
            "changes": [{
                "operation": "insert_at_start",
                "document_content": {
                    "type": "markdown",
                    "markdown": content,
                },
            }],
        });

        let edit_resp = HTTP_CLIENT
            .post("https://slack.com/api/canvases.edit")
            .bearer_auth(&self.token.token_value.0)
            .json(&edit_payload)
            .send()
            .await
            .map_err(|e| SlackError::GeneralError(format!("Canvas edit request failed: {e}")))?;

        let edit_result: CanvasEditResponse = edit_resp.json().await.map_err(|e| {
            SlackError::GeneralError(format!("Failed to parse canvas edit response: {e}"))
        })?;

        if !edit_result.ok {
            return Err(SlackError::GeneralError(format!(
                "Canvas edit failed: {}",
                edit_result
                    .error
                    .unwrap_or_else(|| "Unknown error".to_string())
            )));
        }

        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error if the Slack API request or response parsing fails.
    pub async fn update_canvas_section(
        &self,
        canvas_id: &str,
        section_id: &str,
        content: &str,
    ) -> Result<(), SlackError> {
        let edit_payload = json!({
            "canvas_id": canvas_id,
            "changes": [{
                "operation": "replace",
                "section_id": section_id,
                "document_content": {
                    "type": "markdown",
                    "markdown": content,
                },
            }],
        });

        let edit_resp = HTTP_CLIENT
            .post("https://slack.com/api/canvases.edit")
            .bearer_auth(&self.token.token_value.0)
            .json(&edit_payload)
            .send()
            .await
            .map_err(|e| SlackError::GeneralError(format!("Canvas edit request failed: {e}")))?;

        let edit_result: CanvasEditResponse = edit_resp.json().await.map_err(|e| {
            SlackError::GeneralError(format!("Failed to parse canvas edit response: {e}"))
        })?;

        if !edit_result.ok {
            return Err(SlackError::GeneralError(format!(
                "Canvas edit failed: {}",
                edit_result
                    .error
                    .unwrap_or_else(|| "Unknown error".to_string())
            )));
        }

        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error if the Slack API request or response parsing fails.
    pub async fn get_message_permalink(
        &self,
        channel: &str,
        message_ts: &str,
    ) -> Result<String, SlackError> {
        let payload = json!({
            "channel": channel,
            "message_ts": message_ts,
        });

        let resp = HTTP_CLIENT
            .post("https://slack.com/api/chat.getPermalink")
            .bearer_auth(&self.token.token_value.0)
            .json(&payload)
            .send()
            .await
            .map_err(|e| SlackError::GeneralError(format!("Failed to get permalink: {e}")))?;

        let perm_resp: PermalinkResponse = resp.json().await.map_err(|e| {
            SlackError::GeneralError(format!("Failed to parse permalink response: {e}"))
        })?;

        if !perm_resp.ok {
            return Err(SlackError::GeneralError(format!(
                "Failed to get permalink: {}",
                perm_resp
                    .error
                    .unwrap_or_else(|| "Unknown error".to_string())
            )));
        }

        perm_resp
            .permalink
            .ok_or_else(|| SlackError::GeneralError("No permalink in response".to_string()))
    }

    /// Fetch the summary text posted by this bot in a specific thread.
    ///
    /// Looks up `conversations.replies` and returns the last message authored by the bot
    /// that begins with "*Summary from ". Returns an error if none is found.
    ///
    /// # Errors
    pub async fn get_summary_text_from_thread(
        &self,
        channel_id: &str,
        thread_ts: &str,
    ) -> Result<String, SlackError> {
        // Use raw HTTP to avoid additional type mapping
        let payload = json!({
            "channel": channel_id,
            "ts": thread_ts,
            "limit": 200
        });

        let resp = HTTP_CLIENT
            .post("https://slack.com/api/conversations.replies")
            .bearer_auth(&self.token.token_value.0)
            .json(&payload)
            .send()
            .await
            .map_err(|e| SlackError::GeneralError(format!("conversations.replies HTTP: {e}")))?;

        if !resp.status().is_success() {
            return Err(SlackError::ApiError(format!(
                "conversations.replies HTTP {}",
                resp.status()
            )));
        }

        let body: Value = resp
            .json()
            .await
            .map_err(|e| SlackError::GeneralError(format!("conversations.replies parse: {e}")))?;

        if !body.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            return Err(SlackError::ApiError(format!(
                "conversations.replies error: {}",
                body.get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            )));
        }

        let bot_user_id = self.get_bot_user_id().await.ok();
        if let Some(arr) = body.get("messages").and_then(Value::as_array) {
            // Iterate from newest to oldest
            for msg in arr.iter().rev() {
                let text_opt = msg.get("text").and_then(Value::as_str);
                let from_bot = msg.get("bot_id").is_some()
                    || bot_user_id
                        .as_ref()
                        .and_then(|uid| msg.get("user").and_then(Value::as_str).map(|u| u == uid))
                        .unwrap_or(false);
                if from_bot {
                    if let Some(text) = text_opt {
                        if text.trim_start().starts_with("*Summary from ") {
                            return Ok(text.to_string());
                        }
                    }
                }
            }
        }

        Err(SlackError::GeneralError(
            "No summary message found in thread".to_string(),
        ))
    }
    /// Post a message with Block Kit `blocks` to a channel or thread.
    ///
    /// If `thread_ts_opt` is provided, the message will be posted as a reply in that thread.
    ///
    /// # Errors
    ///
    /// Returns an error if the Slack API request fails.
    pub async fn post_message_with_blocks(
        &self,
        channel_id: &str,
        thread_ts_opt: Option<&str>,
        text_fallback: &str,
        blocks: &Value,
    ) -> Result<(), SlackError> {
        let mut payload = json!({
            "channel": channel_id,
            "text": text_fallback,
            "blocks": blocks,
        });

        if let Some(thread_ts) = thread_ts_opt {
            payload["thread_ts"] = Value::String(thread_ts.to_string());
        }

        self.with_retry(|| async {
            let resp = HTTP_CLIENT
                .post("https://slack.com/api/chat.postMessage")
                .bearer_auth(&self.token.token_value.0)
                .json(&payload)
                .send()
                .await
                .map_err(|e| SlackError::GeneralError(format!("Failed to post message: {e}")))?;

            if !resp.status().is_success() {
                return Err(SlackError::ApiError(format!(
                    "chat.postMessage HTTP {}",
                    resp.status()
                )));
            }

            let body: Value = resp.json().await.map_err(|e| {
                SlackError::GeneralError(format!("chat.postMessage JSON parse error: {e}"))
            })?;

            if !body.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                return Err(SlackError::ApiError(format!(
                    "chat.postMessage error: {}",
                    body.get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                )));
            }

            Ok(())
        })
        .await
    }

    /// Set suggested prompts for an assistant thread in Slack's AI Apps surface.
    /// Note: This uses the documented `assistant.threads.setSuggestedPrompts` endpoint.
    /// The payload shape may evolve; failures are logged as API errors.
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTP call fails or Slack returns an error.
    pub async fn assistant_set_suggested_prompts(
        &self,
        channel_id: &str,
        thread_ts: &str,
        suggestions: &[&str],
    ) -> Result<(), SlackError> {
        let prompts: Vec<Value> = suggestions.iter().map(|s| json!({ "text": s })).collect();

        let payload = json!({
            "channel": channel_id,
            "thread_ts": thread_ts,
            "prompts": prompts,
        });

        self.with_retry(|| async {
            let resp = HTTP_CLIENT
                .post("https://slack.com/api/assistant.threads.setSuggestedPrompts")
                .bearer_auth(&self.token.token_value.0)
                .json(&payload)
                .send()
                .await
                .map_err(|e| {
                    SlackError::GeneralError(format!("Failed to set suggested prompts: {e}"))
                })?;

            if !resp.status().is_success() {
                return Err(SlackError::ApiError(format!(
                    "assistant.threads.setSuggestedPrompts HTTP {}",
                    resp.status()
                )));
            }

            let body: Value = resp.json().await.map_err(|e| {
                SlackError::GeneralError(format!(
                    "assistant.threads.setSuggestedPrompts JSON parse error: {e}"
                ))
            })?;

            if !body.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                return Err(SlackError::ApiError(format!(
                    "assistant.threads.setSuggestedPrompts error: {}",
                    body.get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                )));
            }

            Ok(())
        })
        .await
    }

    /// # Errors
    ///
    /// Returns an error if the Slack API request or response parsing fails.
    pub async fn open_modal(&self, trigger_id: &str, view: &Value) -> Result<(), SlackError> {
        let payload = json!({
            "trigger_id": trigger_id,
            "view": view
        });

        let resp = HTTP_CLIENT
            .post("https://slack.com/api/views.open")
            .bearer_auth(&self.token.token_value.0)
            .json(&payload)
            .send()
            .await
            .map_err(|e| SlackError::GeneralError(format!("Failed to open modal: {e}")))?;

        if !resp.status().is_success() {
            return Err(SlackError::ApiError(format!(
                "views.open HTTP {}",
                resp.status()
            )));
        }

        let json: Value = resp.json().await?;
        if json
            .get("ok")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
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

    // Image-related methods

    /// # Errors
    pub async fn fetch_image_size(&self, url: &str) -> Result<Option<usize>, SlackError> {
        let resp = HTTP_CLIENT
            .head(url)
            .bearer_auth(&self.token.token_value.0)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Ok(None);
        }

        let size_opt = resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<usize>().ok());

        Ok(size_opt)
    }

    /// Perform an authenticated `HEAD` to retrieve image `Content-Type` and size.
    ///
    /// Returns `Ok(Some((content_type_opt, size_opt)))` on 2xx; `Ok(None)` on non-success status.
    ///
    /// # Errors
    ///
    /// Returns `Err(SlackError)` if the HTTP request fails or headers cannot be read.
    pub async fn fetch_image_head(
        &self,
        url: &str,
    ) -> Result<Option<(Option<String>, Option<usize>)>, SlackError> {
        let resp = HTTP_CLIENT
            .head(url)
            .bearer_auth(&self.token.token_value.0)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Ok(None);
        }

        let content_type_opt = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(std::string::ToString::to_string);

        let size_opt = resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<usize>().ok());

        Ok(Some((content_type_opt, size_opt)))
    }

    /// # Errors
    pub async fn ensure_public_file_url(&self, file: &SlackFile) -> Result<String, SlackError> {
        // Step 1: Ensure the file has a public permalink. Avoid extra API call if already present.
        let permalink = if let Some(link) = &file.permalink_public {
            link.to_string()
        } else {
            // Publish the file via Slack API → files.sharedPublicURL
            let api_url = "https://slack.com/api/files.sharedPublicURL";
            let params = [("file", file.id.0.clone())];

            let resp = HTTP_CLIENT
                .post(api_url)
                .bearer_auth(&self.token.token_value.0)
                .form(&params)
                .send()
                .await?;

            if !resp.status().is_success() {
                return Err(SlackError::ApiError(format!(
                    "files.sharedPublicURL failed with status {}",
                    resp.status()
                )));
            }

            let result: Value = resp.json().await?;

            if !result["ok"].as_bool().unwrap_or(false) {
                let error_msg = result["error"]
                    .as_str()
                    .unwrap_or("Unknown error from files.sharedPublicURL");
                return Err(SlackError::ApiError(error_msg.to_string()));
            }

            // Extract the public permalink from the response
            result["file"]["permalink_public"]
                .as_str()
                .ok_or_else(|| SlackError::ApiError("No permalink_public in response".to_string()))?
                .to_string()
        };

        Ok(permalink)
    }
}
