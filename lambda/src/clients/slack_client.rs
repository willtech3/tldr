//! Slack API client module
//!
//! Encapsulates all Slack API interactions with retry logic and error handling.

use once_cell::sync::Lazy;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use slack_morphism::hyper_tokio::{SlackClientHyperConnector, SlackHyperClient};
use slack_morphism::prelude::*;
use slack_morphism::{
    SlackApiToken, SlackApiTokenValue, SlackChannelId, SlackFile, SlackHistoryMessage,
    SlackMessageContent, SlackTs, SlackUserId,
};
use std::time::Duration;
use tokio_retry::strategy::jitter;
use tokio_retry::{Retry, strategy::ExponentialBackoff};
use tracing::warn;

use crate::errors::SlackError;

static SLACK_CLIENT: Lazy<SlackHyperClient> = Lazy::new(|| {
    SlackHyperClient::new(
        SlackClientHyperConnector::new().expect("Failed to create Slack client connector"),
    )
});

static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("Failed to create HTTP client")
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
    pub fn new(token: String) -> Self {
        Self {
            token: SlackApiToken::new(SlackApiTokenValue::new(token)),
        }
    }

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

    pub async fn get_user_im_channel(&self, user_id: &str) -> Result<String, SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT.open_session(&self.token);
            let open_req = SlackApiConversationsOpenRequest::new()
                .with_users(vec![SlackUserId(user_id.to_string())]);

            let result = session.conversations_open(&open_req).await?;
            let channel_id = result.channel.id.0;
            Ok(channel_id)
        })
        .await
    }

    pub async fn get_bot_user_id(&self) -> Result<String, SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT.open_session(&self.token);

            let test_resp = session.auth_test().await?;

            // user_id is directly a SlackUserId, not an Option
            Ok(test_resp.user_id.0)
        })
        .await
    }

    pub async fn get_channel_history(
        &self,
        channel_id: &str,
    ) -> Result<Vec<SlackHistoryMessage>, SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT.open_session(&self.token);

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

    pub async fn get_user_info(&self, user_id: &str) -> Result<String, SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT.open_session(&self.token);
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

    pub async fn get_recent_messages(
        &self,
        channel_id: &str,
        count: u32,
    ) -> Result<Vec<SlackHistoryMessage>, SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT.open_session(&self.token);

            let request = SlackApiConversationsHistoryRequest::new()
                .with_channel(SlackChannelId(channel_id.to_string()))
                .with_limit(std::cmp::min(count, 1000) as u16);

            let result = session.conversations_history(&request).await?;

            let messages = result.messages;

            Ok(messages)
        })
        .await
    }

    pub async fn send_dm(&self, user_id: &str, message: &str) -> Result<(), SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT.open_session(&self.token);
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

    pub async fn post_message(&self, channel_id: &str, message: &str) -> Result<(), SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT.open_session(&self.token);

            let post_req = SlackApiChatPostMessageRequest::new(
                SlackChannelId(channel_id.to_string()),
                SlackMessageContent::new().with_text(message.to_string()),
            );

            session.chat_post_message(&post_req).await?;

            Ok(())
        })
        .await
    }

    pub async fn delete_message(&self, channel_id: &str, ts: &str) -> Result<(), SlackError> {
        self.with_retry(|| async {
            let session = SLACK_CLIENT.open_session(&self.token);

            let delete_req = SlackApiChatDeleteRequest::new(
                SlackChannelId(channel_id.to_string()),
                SlackTs(ts.to_string()),
            );

            session.chat_delete(&delete_req).await?;
            Ok(())
        })
        .await
    }

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
                .map_err(|e| SlackError::GeneralError(format!("HTTP request failed: {}", e)))?;

            if !response.status().is_success() {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                return Err(SlackError::GeneralError(format!(
                    "Failed to update message: {} - {}",
                    status, text
                )));
            }

            Ok(())
        })
        .await
    }

    // Canvas-specific methods

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
            .map_err(|e| SlackError::GeneralError(format!("Failed to get channel info: {}", e)))?;

        let info_data: Value = info_resp.json().await.map_err(|e| {
            SlackError::GeneralError(format!("Failed to parse channel info: {}", e))
        })?;

        let channel_name = info_data
            .get("channel")
            .and_then(|c| c.get("name"))
            .and_then(|n| n.as_str())
            .map(std::string::ToString::to_string)
            .unwrap_or_else(|| channel_id.to_string());

        Ok(channel_name)
    }

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
            .map_err(|e| SlackError::GeneralError(format!("Failed to get channel info: {}", e)))?;

        let info_data: Value = info_resp.json().await.map_err(|e| {
            SlackError::GeneralError(format!("Failed to parse channel info: {}", e))
        })?;

        let canvas_id_opt = info_data
            .get("channel")
            .and_then(|c| c.get("properties"))
            .and_then(|p| p.get("canvas"))
            .and_then(|c| c.get("id"))
            .and_then(|id| id.as_str())
            .map(std::string::ToString::to_string);

        Ok(canvas_id_opt)
    }

    pub async fn create_canvas(
        &self,
        channel_id: &str,
        _title: &str,
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
                SlackError::GeneralError(format!("Canvas creation request failed: {}", e))
            })?;

        let create_resp: CanvasCreateResponse = resp.json().await.map_err(|e| {
            SlackError::GeneralError(format!("Failed to parse canvas creation response: {}", e))
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
            .map_err(|e| SlackError::GeneralError(format!("Canvas edit request failed: {}", e)))?;

        let edit_result: CanvasEditResponse = edit_resp.json().await.map_err(|e| {
            SlackError::GeneralError(format!("Failed to parse canvas edit response: {}", e))
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
            .map_err(|e| SlackError::GeneralError(format!("Failed to get permalink: {}", e)))?;

        let perm_resp: PermalinkResponse = resp.json().await.map_err(|e| {
            SlackError::GeneralError(format!("Failed to parse permalink response: {}", e))
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
            .map_err(|e| SlackError::GeneralError(format!("Failed to open modal: {}", e)))?;

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

    // Image-related methods

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
