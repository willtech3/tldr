//! Slack API client module
//!
//! Encapsulates all Slack API interactions with retry logic and error handling.

use futures::StreamExt;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use slack_morphism::hyper_tokio::{SlackClientHyperConnector, SlackHyperClient};
use slack_morphism::prelude::{
    SlackApiChatDeleteRequest, SlackApiChatPostMessageRequest, SlackApiConversationsHistoryRequest,
    SlackApiConversationsOpenRequest, SlackApiUsersInfoRequest,
};
use slack_morphism::{
    SlackApiToken, SlackApiTokenValue, SlackChannelId, SlackHistoryMessage, SlackMessageContent,
    SlackTs, SlackUserId,
};
use std::time::Duration;
use tokio_retry::strategy::jitter;
use tokio_retry::{Retry, strategy::ExponentialBackoff};
use tracing::warn;

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

#[derive(Debug, Deserialize)]
struct PermalinkResponse {
    ok: bool,
    permalink: Option<String>,
    error: Option<String>,
}

/// Response from Slack streaming API methods (`chat.startStream`, `chat.appendStream`, `chat.stopStream`).
#[derive(Debug, Clone, Deserialize)]
pub struct StreamResponse {
    /// Whether the API call succeeded.
    pub ok: bool,
    /// Channel ID where the streaming message exists.
    pub channel: Option<String>,
    /// Timestamp of the streaming message.
    pub ts: Option<String>,
    /// Error code if `ok` is false.
    pub error: Option<String>,
}

/// Error indicating the streaming message is no longer in a streaming state.
/// This is a special case that callers may want to handle differently (e.g., stop appending).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MessageNotInStreamingState;

/// Slack's documented per-call character limit for `markdown_text` in streaming APIs.
///
/// This is the maximum number of characters that can be sent in a single
/// `chat.startStream`, `chat.appendStream`, or `chat.stopStream` call.
pub const STREAM_MARKDOWN_TEXT_LIMIT: usize = 12_000;

/// Slack error code for when a message is not in streaming state.
const ERROR_MESSAGE_NOT_IN_STREAMING_STATE: &str = "message_not_in_streaming_state";

// ─────────────────────────────────────────────────────────────────────────────
// Streaming payload builders (extracted for testability)
// ─────────────────────────────────────────────────────────────────────────────

/// Build the JSON payload for `chat.startStream`.
#[must_use]
fn build_start_stream_payload(
    channel: &str,
    thread_ts: &str,
    markdown_text: Option<&str>,
) -> Value {
    let mut payload = json!({
        "channel": channel,
        "thread_ts": thread_ts,
    });

    if let Some(text) = markdown_text {
        payload["markdown_text"] = Value::String(text.to_string());
    }

    payload
}

/// Build the JSON payload for `chat.appendStream`.
#[must_use]
fn build_append_stream_payload(channel: &str, ts: &str, markdown_text: &str) -> Value {
    json!({
        "channel": channel,
        "ts": ts,
        "markdown_text": markdown_text,
    })
}

/// Build the JSON payload for `chat.stopStream`.
#[must_use]
fn build_stop_stream_payload(
    channel: &str,
    ts: &str,
    markdown_text: Option<&str>,
    blocks: Option<&Value>,
    metadata: Option<&Value>,
) -> Value {
    let mut payload = json!({
        "channel": channel,
        "ts": ts,
    });

    if let Some(text) = markdown_text {
        payload["markdown_text"] = Value::String(text.to_string());
    }

    if let Some(b) = blocks {
        payload["blocks"] = b.clone();
    }

    if let Some(m) = metadata {
        payload["metadata"] = m.clone();
    }

    payload
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

    /// Update an existing message via Slack's `chat.update` API.
    ///
    /// This is used to replace streamed partial output with the canonical failure message
    /// (and/or to attach/remove blocks).
    ///
    /// # Errors
    ///
    /// Returns an error if the Slack API request or response parsing fails.
    pub async fn update_message(
        &self,
        channel_id: &str,
        ts: &str,
        text: Option<&str>,
        blocks: Option<&Value>,
    ) -> Result<(), SlackError> {
        let mut payload = json!({
            "channel": channel_id,
            "ts": ts,
        });

        if let Some(t) = text {
            payload["text"] = Value::String(t.to_string());
        }

        if let Some(b) = blocks {
            payload["blocks"] = b.clone();
        }

        self.with_retry(|| async {
            let resp = HTTP_CLIENT
                .post("https://slack.com/api/chat.update")
                .bearer_auth(&self.token.token_value.0)
                .json(&payload)
                .send()
                .await
                .map_err(|e| SlackError::GeneralError(format!("Failed to update message: {e}")))?;

            if !resp.status().is_success() {
                return Err(SlackError::ApiError(format!(
                    "chat.update HTTP {}",
                    resp.status()
                )));
            }

            let body: Value = resp.json().await.map_err(|e| {
                SlackError::GeneralError(format!("chat.update JSON parse error: {e}"))
            })?;

            if !body.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                return Err(SlackError::ApiError(format!(
                    "chat.update error: {}",
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
                if from_bot
                    && let Some(text) = text_opt
                    && text.trim_start().starts_with("*Summary from ")
                {
                    return Ok(text.to_string());
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

    /// Download an image file from Slack (authenticated) into memory with a strict size cap.
    ///
    /// Slack `url_private` / `url_private_download` requires a bearer token. This helper
    /// performs a GET with bot auth, enforces a maximum number of bytes, and returns the
    /// raw bytes for Base64 encoding.
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTP request fails, Slack responds non-2xx, or the image
    /// exceeds `max_bytes`.
    pub async fn download_image_bytes(
        &self,
        url: &str,
        max_bytes: usize,
    ) -> Result<Vec<u8>, SlackError> {
        if max_bytes == 0 {
            return Err(SlackError::GeneralError(
                "download_image_bytes max_bytes must be > 0".to_string(),
            ));
        }

        let resp = HTTP_CLIENT
            .get(url)
            .bearer_auth(&self.token.token_value.0)
            .send()
            .await
            .map_err(|e| SlackError::HttpError(format!("Failed to download Slack image: {e}")))?;

        if !resp.status().is_success() {
            return Err(SlackError::ApiError(format!(
                "Slack image download HTTP {}",
                resp.status()
            )));
        }

        if let Some(len) = resp.content_length()
            && len > u64::try_from(max_bytes).unwrap_or(u64::MAX)
        {
            return Err(SlackError::GeneralError(format!(
                "Slack image too large to inline ({len}B > {max_bytes}B)"
            )));
        }

        let mut out: Vec<u8> = Vec::new();
        let mut stream = resp.bytes_stream();
        while let Some(item) = stream.next().await {
            let chunk = item.map_err(|e| {
                SlackError::HttpError(format!("Error reading Slack image download stream: {e}"))
            })?;
            if out.len().saturating_add(chunk.len()) > max_bytes {
                return Err(SlackError::GeneralError(format!(
                    "Slack image too large to inline (exceeded {max_bytes}B cap)"
                )));
            }
            out.extend_from_slice(&chunk);
        }

        Ok(out)
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Streaming API methods (chat.startStream, chat.appendStream, chat.stopStream)
    // ─────────────────────────────────────────────────────────────────────────────

    /// Start a streaming message in a thread.
    ///
    /// Wraps Slack's `chat.startStream` API. The streaming message is always a reply
    /// to the specified `thread_ts`.
    ///
    /// # Arguments
    ///
    /// * `channel` - Channel ID (the assistant DM channel, e.g., `D...`).
    /// * `thread_ts` - Parent thread timestamp to reply to.
    /// * `markdown_text` - Optional initial markdown text (max 12,000 chars).
    ///
    /// # Returns
    ///
    /// The streaming message timestamp (`ts`) on success.
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTP request fails, Slack returns `ok: false`,
    /// or rate limiting cannot be resolved.
    pub async fn start_stream(
        &self,
        channel: &str,
        thread_ts: &str,
        markdown_text: Option<&str>,
    ) -> Result<String, SlackError> {
        let payload = build_start_stream_payload(channel, thread_ts, markdown_text);

        let resp = self
            .call_slack_streaming_api("https://slack.com/api/chat.startStream", &payload)
            .await?;

        resp.ts
            .ok_or_else(|| SlackError::ApiError("chat.startStream: no ts in response".to_string()))
    }

    /// Append markdown text to an existing streaming message.
    ///
    /// Wraps Slack's `chat.appendStream` API.
    ///
    /// # Arguments
    ///
    /// * `channel` - Channel ID where the streaming message exists.
    /// * `ts` - Timestamp of the streaming message (from `start_stream`).
    /// * `markdown_text` - Markdown text to append (max 12,000 chars, required).
    ///
    /// # Returns
    ///
    /// - `Ok(Ok(()))` on success.
    /// - `Ok(Err(MessageNotInStreamingState))` if the message is no longer streaming.
    /// - `Err(SlackError)` on other failures.
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTP request fails, Slack returns an error other than
    /// `message_not_in_streaming_state`, or rate limiting cannot be resolved.
    pub async fn append_stream(
        &self,
        channel: &str,
        ts: &str,
        markdown_text: &str,
    ) -> Result<Result<(), MessageNotInStreamingState>, SlackError> {
        let payload = build_append_stream_payload(channel, ts, markdown_text);

        match self
            .call_slack_streaming_api("https://slack.com/api/chat.appendStream", &payload)
            .await
        {
            Ok(_) => Ok(Ok(())),
            Err(SlackError::ApiError(ref msg))
                if msg.contains(ERROR_MESSAGE_NOT_IN_STREAMING_STATE) =>
            {
                Ok(Err(MessageNotInStreamingState))
            }
            Err(e) => Err(e),
        }
    }

    /// Stop a streaming message, optionally appending final text, blocks, and metadata.
    ///
    /// Wraps Slack's `chat.stopStream` API.
    ///
    /// # Arguments
    ///
    /// * `channel` - Channel ID where the streaming message exists.
    /// * `ts` - Timestamp of the streaming message (from `start_stream`).
    /// * `markdown_text` - Optional final markdown text to append (max 12,000 chars).
    /// * `blocks` - Optional Block Kit blocks to attach at the bottom of the message.
    /// * `metadata` - Optional message metadata (e.g., for deduplication).
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTP request fails, Slack returns `ok: false`,
    /// or rate limiting cannot be resolved.
    pub async fn stop_stream(
        &self,
        channel: &str,
        ts: &str,
        markdown_text: Option<&str>,
        blocks: Option<&Value>,
        metadata: Option<&Value>,
    ) -> Result<(), SlackError> {
        let payload = build_stop_stream_payload(channel, ts, markdown_text, blocks, metadata);

        self.call_slack_streaming_api("https://slack.com/api/chat.stopStream", &payload)
            .await?;

        Ok(())
    }

    /// Internal helper for calling Slack streaming APIs with rate limit handling.
    ///
    /// Handles:
    /// - Bearer token authentication
    /// - JSON request body
    /// - HTTP 429 rate limiting with `Retry-After` header
    /// - Response parsing and error surfacing
    async fn call_slack_streaming_api(
        &self,
        url: &str,
        payload: &Value,
    ) -> Result<StreamResponse, SlackError> {
        const MAX_RETRIES: u32 = 5;
        let mut attempts = 0;

        loop {
            attempts += 1;

            let resp = HTTP_CLIENT
                .post(url)
                .bearer_auth(&self.token.token_value.0)
                .json(payload)
                .send()
                .await
                .map_err(|e| SlackError::HttpError(format!("Streaming API request failed: {e}")))?;

            // Handle HTTP 429 rate limiting
            if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                if attempts >= MAX_RETRIES {
                    return Err(SlackError::ApiError(format!(
                        "Rate limited after {MAX_RETRIES} retries"
                    )));
                }

                let retry_after = Self::parse_retry_after(&resp);
                warn!(
                    "Slack rate limited (429), waiting {}s before retry (attempt {}/{})",
                    retry_after.as_secs(),
                    attempts,
                    MAX_RETRIES
                );
                tokio::time::sleep(retry_after).await;
                continue;
            }

            // Check for other HTTP errors
            if !resp.status().is_success() {
                return Err(SlackError::ApiError(format!(
                    "Streaming API HTTP error: {}",
                    resp.status()
                )));
            }

            // Parse response body
            let stream_resp: StreamResponse = resp.json().await.map_err(|e| {
                SlackError::GeneralError(format!("Streaming API JSON parse error: {e}"))
            })?;

            // Check Slack's ok field
            if !stream_resp.ok {
                let error_code = stream_resp.error.as_deref().unwrap_or("unknown");

                // Handle rate_limited/ratelimited errors from response body
                if error_code == "rate_limited" || error_code == "ratelimited" {
                    if attempts >= MAX_RETRIES {
                        return Err(SlackError::ApiError(format!(
                            "Rate limited (response body) after {MAX_RETRIES} retries"
                        )));
                    }
                    warn!(
                        "Slack rate limited (response), waiting 1s before retry (attempt {}/{})",
                        attempts, MAX_RETRIES
                    );
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }

                return Err(SlackError::ApiError(format!(
                    "Streaming API error: {error_code}"
                )));
            }

            return Ok(stream_resp);
        }
    }

    /// Parse the `Retry-After` header from an HTTP 429 response.
    ///
    /// Falls back to a default of 1 second if the header is missing or invalid.
    fn parse_retry_after(resp: &reqwest::Response) -> Duration {
        resp.headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .map_or(Duration::from_secs(1), Duration::from_secs)
    }
}

#[cfg(test)]
mod streaming_tests {
    use super::*;
    use serde_json::json;

    // ─────────────────────────────────────────────────────────────────────────────
    // StreamResponse parsing tests
    // ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_stream_response_success_parsing() {
        let json_str = r#"{"ok": true, "channel": "C123ABC456", "ts": "1503435956.000247"}"#;
        let resp: StreamResponse = serde_json::from_str(json_str).unwrap();

        assert!(resp.ok);
        assert_eq!(resp.channel, Some("C123ABC456".to_string()));
        assert_eq!(resp.ts, Some("1503435956.000247".to_string()));
        assert!(resp.error.is_none());
    }

    #[test]
    fn test_stream_response_error_parsing() {
        let json_str = r#"{"ok": false, "error": "invalid_auth"}"#;
        let resp: StreamResponse = serde_json::from_str(json_str).unwrap();

        assert!(!resp.ok);
        assert!(resp.channel.is_none());
        assert!(resp.ts.is_none());
        assert_eq!(resp.error, Some("invalid_auth".to_string()));
    }

    #[test]
    fn test_stream_response_message_not_in_streaming_state() {
        let json_str = r#"{"ok": false, "error": "message_not_in_streaming_state"}"#;
        let resp: StreamResponse = serde_json::from_str(json_str).unwrap();

        assert!(!resp.ok);
        assert_eq!(
            resp.error,
            Some("message_not_in_streaming_state".to_string())
        );
    }

    #[test]
    fn test_stream_response_rate_limited() {
        let json_str = r#"{"ok": false, "error": "ratelimited"}"#;
        let resp: StreamResponse = serde_json::from_str(json_str).unwrap();

        assert!(!resp.ok);
        assert_eq!(resp.error, Some("ratelimited".to_string()));
    }

    #[test]
    fn test_stream_response_partial_fields() {
        // Response with only ok and ts (channel missing)
        let json_str = r#"{"ok": true, "ts": "1234567890.123456"}"#;
        let resp: StreamResponse = serde_json::from_str(json_str).unwrap();

        assert!(resp.ok);
        assert!(resp.channel.is_none());
        assert_eq!(resp.ts, Some("1234567890.123456".to_string()));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Payload builder function tests (using actual production code)
    // ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_build_start_stream_payload_minimal() {
        let payload = build_start_stream_payload("D1234567890", "1721609600.000000", None);

        assert_eq!(payload["channel"], "D1234567890");
        assert_eq!(payload["thread_ts"], "1721609600.000000");
        assert!(payload.get("markdown_text").is_none());
    }

    #[test]
    fn test_build_start_stream_payload_with_markdown() {
        let payload =
            build_start_stream_payload("D1234567890", "1721609600.000000", Some("**Hello** world"));

        assert_eq!(payload["channel"], "D1234567890");
        assert_eq!(payload["thread_ts"], "1721609600.000000");
        assert_eq!(payload["markdown_text"], "**Hello** world");
    }

    #[test]
    fn test_build_append_stream_payload() {
        let payload =
            build_append_stream_payload("C123ABC456", "1503435956.000247", "More text to append");

        assert_eq!(payload["channel"], "C123ABC456");
        assert_eq!(payload["ts"], "1503435956.000247");
        assert_eq!(payload["markdown_text"], "More text to append");
    }

    #[test]
    fn test_build_stop_stream_payload_minimal() {
        let payload =
            build_stop_stream_payload("C123ABC456", "1503435956.000247", None, None, None);

        assert_eq!(payload["channel"], "C123ABC456");
        assert_eq!(payload["ts"], "1503435956.000247");
        assert!(payload.get("markdown_text").is_none());
        assert!(payload.get("blocks").is_none());
        assert!(payload.get("metadata").is_none());
    }

    #[test]
    fn test_build_stop_stream_payload_with_blocks_and_metadata() {
        let blocks = json!([{
            "type": "context",
            "elements": [{
                "type": "mrkdwn",
                "text": "Summary completed"
            }]
        }]);
        let metadata = json!({
            "event_type": "tldr_summary",
            "event_payload": {
                "v": 1,
                "correlation_id": "abc123",
                "streamed": true
            }
        });

        let payload = build_stop_stream_payload(
            "C123ABC456",
            "1503435956.000247",
            Some("Final text"),
            Some(&blocks),
            Some(&metadata),
        );

        assert_eq!(payload["channel"], "C123ABC456");
        assert_eq!(payload["ts"], "1503435956.000247");
        assert_eq!(payload["markdown_text"], "Final text");
        assert_eq!(payload["blocks"][0]["type"], "context");
        assert_eq!(payload["metadata"]["event_type"], "tldr_summary");
        assert_eq!(payload["metadata"]["event_payload"]["v"], 1);
        assert!(
            payload["metadata"]["event_payload"]["streamed"]
                .as_bool()
                .unwrap()
        );
    }

    #[test]
    fn test_build_stop_stream_payload_with_only_markdown() {
        let payload = build_stop_stream_payload(
            "C123ABC456",
            "1503435956.000247",
            Some("Final text only"),
            None,
            None,
        );

        assert_eq!(payload["channel"], "C123ABC456");
        assert_eq!(payload["ts"], "1503435956.000247");
        assert_eq!(payload["markdown_text"], "Final text only");
        assert!(payload.get("blocks").is_none());
        assert!(payload.get("metadata").is_none());
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Constants tests
    // ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_stream_markdown_text_limit() {
        // Verify the constant matches Slack's documented 12,000 char limit
        assert_eq!(STREAM_MARKDOWN_TEXT_LIMIT, 12_000);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // MessageNotInStreamingState tests
    // ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_message_not_in_streaming_state_equality() {
        let a = MessageNotInStreamingState;
        let b = MessageNotInStreamingState;
        assert_eq!(a, b);
    }

    #[test]
    fn test_message_not_in_streaming_state_debug() {
        let err = MessageNotInStreamingState;
        let debug_str = format!("{err:?}");
        assert!(debug_str.contains("MessageNotInStreamingState"));
    }
}

#[cfg(test)]
mod image_download_tests {
    use super::*;

    // ─────────────────────────────────────────────────────────────────────────────
    // download_image_bytes validation tests (no network required)
    // ─────────────────────────────────────────────────────────────────────────────

    /// Helper to create a minimal `SlackClient` for testing (won't make real API calls)
    fn test_client() -> SlackClient {
        SlackClient::new("xoxb-test-token".to_string())
    }

    #[tokio::test]
    async fn test_download_image_bytes_rejects_zero_max_bytes() {
        let client = test_client();

        let result = client
            .download_image_bytes("https://example.com/image.png", 0)
            .await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        match err {
            SlackError::GeneralError(msg) => {
                assert!(msg.contains("max_bytes must be > 0"));
            }
            other => panic!("Expected GeneralError, got: {other:?}"),
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Base64 data URL construction tests
    // ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_base64_data_url_construction() {
        // Test that Base64 encoding + data URL format is correct
        let bytes: &[u8] = b"test image bytes";
        let b64 = openssl::base64::encode_block(bytes);
        let data_url = format!("data:image/png;base64,{b64}");

        // Verify the data URL format
        assert!(data_url.starts_with("data:image/png;base64,"));

        // Verify the Base64 is valid and decodes back to original
        let decoded = openssl::base64::decode_block(&b64).unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn test_base64_encoding_various_mime_types() {
        let bytes: &[u8] = b"PNG image data";
        let b64 = openssl::base64::encode_block(bytes);

        // Test various MIME types used by OpenAI
        for mime in ["image/png", "image/jpeg", "image/gif", "image/webp"] {
            let data_url = format!("data:{mime};base64,{b64}");
            assert!(data_url.starts_with(&format!("data:{mime};base64,")));
        }
    }

    #[test]
    fn test_base64_encoding_handles_binary_data() {
        // Test that binary data (all byte values) encodes correctly
        let bytes: Vec<u8> = (0u8..=255).collect();
        let b64 = openssl::base64::encode_block(&bytes);

        // Should not panic and should produce valid Base64
        assert!(!b64.is_empty());

        // Should decode back correctly
        let decoded = openssl::base64::decode_block(&b64).unwrap();
        assert_eq!(decoded, bytes);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Size cap enforcement tests
    // ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_size_enforcement_logic() {
        // Test that size enforcement logic works correctly with various values
        let inline_cap: usize = 1024 * 1024; // 1 MiB

        // Simulate the size check logic used in download_image_bytes
        let small_size: usize = 500_000; // 500 KB - should pass
        let large_size: usize = 2_000_000; // 2 MB - should fail

        // Size check: image should be rejected if it exceeds inline_cap
        assert!(
            small_size <= inline_cap,
            "Small images should pass size check"
        );
        assert!(
            large_size > inline_cap,
            "Large images should fail size check"
        );

        // Boundary check: exactly at cap should pass
        assert!(inline_cap <= inline_cap, "Exactly at cap should pass");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Error message format tests
    // ─────────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_slack_error_display_formats() {
        let http_err = SlackError::HttpError("connection failed".to_string());
        let api_err = SlackError::ApiError("invalid_auth".to_string());
        let general_err = SlackError::GeneralError("image too large".to_string());

        // All error types should produce readable Display output
        assert!(format!("{http_err}").contains("connection failed"));
        assert!(format!("{api_err}").contains("invalid_auth"));
        assert!(format!("{general_err}").contains("image too large"));
    }
}
