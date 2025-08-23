use super::client::SlackClient;
use super::response_builder::create_replace_original_payload;
use crate::ai::LlmClient;
use base64::Engine;
use base64::engine::general_purpose;
use openai_api_rs::v1::chat_completion::{
    self as chat_completion, ChatCompletionMessage, Content, ContentType, ImageUrl, ImageUrlType,
    MessageRole,
};
use reqwest::Client;
use serde_json::Value;
use slack_morphism::{SlackFile, SlackHistoryMessage};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tracing::{debug, error, info, warn};
use url::Url;

use crate::core::config::AppConfig;
use crate::errors::SlackError;

// HTTP client for image fetches
static HTTP_CLIENT: std::sync::LazyLock<Client> = std::sync::LazyLock::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .expect("failed to build HTTP client")
});

/// Common Slack functionality
pub struct SlackBot {
    slack_client: SlackClient,
    llm_client: LlmClient,
}

impl SlackBot {
    /// Construct a `SlackBot` composed of a `SlackClient` and `LlmClient`.
    ///
    /// # Errors
    ///
    /// Currently this constructor does not perform fallible initialization and
    /// returns `Ok(Self)` for valid inputs. It keeps `Result` to allow future
    /// construction that might validate configuration or perform I/O.
    pub fn new(config: &AppConfig) -> Result<Self, SlackError> {
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
    #[must_use]
    pub fn slack_client(&self) -> &SlackClient {
        &self.slack_client
    }

    /// Get a reference to the LLM client
    #[must_use]
    pub fn llm_client(&self) -> &LlmClient {
        &self.llm_client
    }

    /// Opens a Block Kit modal using Slack's `views.open` API.
    ///
    /// # Errors
    ///
    /// Returns an error if the Slack API call fails.
    pub async fn open_modal(&self, trigger_id: &str, view: &Value) -> Result<(), SlackError> {
        self.slack_client.open_modal(trigger_id, view).await
    }

    /// # Errors
    ///
    /// Returns an error if the Slack API call fails.
    pub async fn delete_message(&self, channel_id: &str, ts: &str) -> Result<(), SlackError> {
        match self.slack_client.delete_message(channel_id, ts).await {
            Ok(()) => {
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
    /// Uses Slack's `response_url` mechanism which allows modifying the original message
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTP call to the `response_url` fails.
    pub async fn replace_original_message(
        &self,
        response_url: &str,
        text: Option<&str>,
    ) -> Result<(), SlackError> {
        let payload = create_replace_original_payload(text);
        self.slack_client
            .replace_original_message(response_url, payload)
            .await
            .map(|()| {
                info!("Successfully replaced original message via response_url");
            })
    }

    // Fetch image and return as data URI for inline model consumption
    async fn fetch_image_as_data_uri(
        &self,
        url: &str,
        fallback_mime: &str,
    ) -> Result<String, SlackError> {
        let response = HTTP_CLIENT
            .get(url)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| SlackError::HttpError(format!("Failed to fetch image: {e}")))?;

        let header_mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok());
        let mut mime = crate::ai::client::canonicalize_mime(header_mime.unwrap_or(fallback_mime));

        // Ensure final mime is supported & canonical; fallback to provided mime otherwise
        if !self.llm_client.is_allowed_image_mime(&mime) {
            mime = crate::ai::client::canonicalize_mime(fallback_mime);
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| SlackError::HttpError(format!("Failed to read image bytes: {e}")))?;

        let encoded = general_purpose::STANDARD.encode(&bytes);

        Ok(format!("data:{mime};base64,{encoded}"))
    }

    async fn fetch_image_size(&self, url: &str) -> Result<Option<usize>, SlackError> {
        self.slack_client.fetch_image_size(url).await
    }

    // Validate a candidate public URL and return its canonical content-type if supported
    async fn validate_candidate(&self, url: &Url) -> Result<Option<String>, SlackError> {
        if let Ok(resp) = HTTP_CLIENT
            .head(url.clone())
            .timeout(Duration::from_secs(10))
            .send()
            .await
        {
            let status = resp.status();
            let ct = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("(unknown)");
            info!("HEAD {} -> {} (CT={})", url, status, ct);
            if status.is_client_error() || status.is_server_error() {
                warn!("Public URL returned error status {}", status);
                return Ok(None);
            }
            let canon_ct = crate::ai::client::canonicalize_mime(ct);
            if self.llm_client.is_allowed_image_mime(&canon_ct) {
                return Ok(Some(canon_ct));
            }
        } else {
            warn!("HEAD request failed for {}", url);
        }
        Ok(None)
    }

    async fn ensure_public_file_url(&self, file: &SlackFile) -> Result<String, SlackError> {
        // Step 1: Use slack_client to ensure the file has a public permalink
        let permalink = self.slack_client.ensure_public_file_url(file).await?;

        // Step 2: Extract pub_secret from the permalink.
        let secret = Url::parse(&permalink)
            .ok()
            .and_then(|u| {
                // First, try query string
                if let Some(val) = u
                    .query_pairs()
                    .find(|(k, _)| k == "pub_secret")
                    .map(|(_, v)| v.to_string())
                {
                    return Some(val);
                }

                // Fallback: public permalinks are of form
                // https://slack-files.com/TXXXX-FFFF-<secret>
                // Extract last hyphen-separated part of last path segment.
                u.path_segments()
                    .and_then(|mut segs| segs.next_back().map(std::string::ToString::to_string))
                    .and_then(|last_seg| {
                        last_seg
                            .rsplit('-')
                            .next()
                            .map(std::string::ToString::to_string)
                    })
            })
            .ok_or_else(|| {
                SlackError::ApiError("pub_secret missing in permalink_public".to_string())
            })?;

        // Step 3: Construct direct asset URL by adding pub_secret to download URL.
        let base_download = Self::get_slack_file_download_url(file)
            .ok_or_else(|| SlackError::ApiError("No downloadable URL on SlackFile".to_string()))?;

        debug!(
            "Ensuring public URL for file {} (mimetype={:?}): base={}",
            file.id.0,
            file.mimetype.as_ref().map(|m| m.0.clone()),
            base_download
        );

        // Start with the original private download URL and attach the pub_secret.
        let mut direct = base_download.clone();
        direct.set_query(Some(&format!("pub_secret={secret}")));

        // First attempt: original /download/ path (direct already has it)
        let mut candidate = direct.clone();

        let is_supported = self.validate_candidate(&candidate).await?;

        // If first candidate was unsupported, try without "/download/" segment
        if is_supported.is_none() && candidate.path().contains("/download/") {
            let mut new_path = candidate.path().replace("/download/", "/");
            while new_path.contains("//") {
                new_path = new_path.replace("//", "/");
            }
            let mut alt = candidate.clone();
            alt.set_path(&new_path);

            if let Some(_ct) = self.validate_candidate(&alt).await? {
                candidate = alt;
            } else {
                warn!("Both download and non-download variants had unsupported MIME types");
                return Err(SlackError::ApiError(
                    "No supported public URL variant".to_string(),
                ));
            }
        }

        Ok(candidate.to_string())
    }

    /// Helper to obtain the best URL for downloading a Slack file.
    /// Prefers `url_private_download` (direct download) and falls back to `url_private`.
    fn get_slack_file_download_url(file: &SlackFile) -> Option<&Url> {
        file.url_private_download
            .as_ref()
            .or(file.url_private.as_ref())
    }

    /// Build the complete prompt as chat messages ready for the `OpenAI` request.
    /// `messages_markdown` should already contain the raw Slack messages,
    /// separated by newlines.
    fn build_prompt(
        &self,
        messages_markdown: &str,
        custom_opt: Option<&str>,
    ) -> Vec<ChatCompletionMessage> {
        self.llm_client.build_prompt(messages_markdown, custom_opt)
    }

    /// # Errors
    ///
    /// Returns an error if the `OpenAI` API call fails or Slack API lookups needed
    /// for prompt construction fail.
    #[allow(clippy::too_many_lines)] // The orchestration here benefits from locality; refactor if it grows.
    pub async fn summarize_messages_with_chatgpt(
        &mut self,
        _config: &AppConfig,
        messages: &[SlackHistoryMessage],
        channel_id: &str,
        custom_prompt: Option<&str>,
    ) -> Result<String, SlackError> {
        if messages.is_empty() {
            return Ok("No messages to summarize.".to_string());
        }

        // Get channel name from channel_id
        let channel_name = self.slack_client.get_channel_name(channel_id).await?;

        // Collect unique user IDs
        let user_ids: HashSet<String> = messages
            .iter()
            .filter_map(|msg| {
                msg.sender.user.as_ref().and_then(|user| {
                    if user.as_ref() == "Unknown User" {
                        None
                    } else {
                        Some(user.as_ref().to_string())
                    }
                })
            })
            .collect();

        // Fetch all user info in advance and build a cache
        let mut user_info_cache = HashMap::new();
        for user_id in user_ids {
            match self.slack_client.get_user_info(&user_id).await {
                Ok(name) => {
                    user_info_cache.insert(user_id, name);
                }
                Err(e) => {
                    error!("Failed to get user info for {}: {}", user_id, e);
                    user_info_cache.insert(user_id.clone(), user_id);
                }
            }
        }

        // Format messages using the cache
        let formatted_messages: Vec<String> = messages
            .iter()
            .map(|msg| {
                let user_id = msg
                    .sender
                    .user
                    .as_ref()
                    .map_or("Unknown User", |uid| uid.as_ref());

                // Get the real username from cache
                let author = if user_id == "Unknown User" {
                    user_id.to_string()
                } else {
                    user_info_cache
                        .get(user_id)
                        .map_or_else(|| user_id.to_string(), std::clone::Clone::clone)
                };

                let ts = msg.origin.ts.clone();
                let text = msg.content.text.as_deref().unwrap_or("");

                format!("[{ts}] {author}: {text}")
            })
            .collect();

        // Build the full prompt using the new method with channel context
        let messages_text = format!(
            "Channel: #{}\n\n{}",
            channel_name,
            formatted_messages.join("\n")
        );

        // 1. Base text portion
        let mut prompt = self.build_prompt(&messages_text, custom_prompt);

        // 2. Append image data so the model can see pictures
        for msg in messages {
            if let Some(files) = &msg.content.files {
                let mut imgs: Vec<ImageUrl> = Vec::new();
                for file in files {
                    if let Some(url) = Self::get_slack_file_download_url(file) {
                        // Determine mime type: prefer Slack-provided mimetype, else guess from URL path
                        let raw_mime: String = file.mimetype.as_ref().map_or_else(
                            || {
                                mime_guess::from_path(url.path())
                                    .first_or_octet_stream()
                                    .essence_str()
                                    .to_string()
                            },
                            |m| m.0.clone(),
                        );

                        let canon = crate::ai::client::canonicalize_mime(&raw_mime);
                        if !self.llm_client.is_allowed_image_mime(&canon) {
                            continue; // Skip unsupported formats like HEIC, TIFF, etc.
                        }

                        let size_opt = self.fetch_image_size(url.as_str()).await.unwrap_or(None);

                        // Skip if over OpenAI hard limit
                        let url_max = self.llm_client.get_url_image_max_bytes();
                        if let Some(sz) = size_opt.filter(|&s| s > url_max) {
                            info!("Skipping image {} because size {}B > {}B", url, sz, url_max);
                            continue;
                        }

                        let inline_max = self.llm_client.get_inline_image_max_bytes();
                        let use_inline = match size_opt {
                            Some(sz) => sz <= inline_max,
                            None => false,
                        };

                        if use_inline {
                            match self.fetch_image_as_data_uri(url.as_str(), &canon).await {
                                Ok(data_uri) => imgs.push(ImageUrl {
                                    r#type: ContentType::image_url,
                                    text: None,
                                    image_url: Some(ImageUrlType { url: data_uri }),
                                }),
                                Err(e) => error!("Failed to fetch image {}: {}", url, e),
                            }
                        } else {
                            match self.ensure_public_file_url(file).await {
                                Ok(public_url) => imgs.push(ImageUrl {
                                    r#type: ContentType::image_url,
                                    text: None,
                                    image_url: Some(ImageUrlType { url: public_url }),
                                }),
                                Err(e) => {
                                    error!("Failed to get public URL for image {}: {}", url, e);
                                }
                            }
                        }
                    }
                }
                if !imgs.is_empty() {
                    // Determine if original Slack message had any visible text
                    let text_is_empty = msg
                        .content
                        .text
                        .as_ref()
                        .is_none_or(|t| t.trim().is_empty());

                    if text_is_empty {
                        // Inject a minimal placeholder so the model treats the images as user input
                        let placeholder = if imgs.len() == 1 {
                            "(uploaded an image)".to_string()
                        } else {
                            format!("(uploaded {} images)", imgs.len())
                        };

                        prompt.push(chat_completion::ChatCompletionMessage {
                            role: MessageRole::user,
                            content: Content::Text(placeholder),
                            name: None,
                            tool_calls: None,
                            tool_call_id: None,
                        });
                    }

                    // Now push the actual image payload so the model can inspect them
                    prompt.push(chat_completion::ChatCompletionMessage {
                        role: MessageRole::user,
                        content: Content::ImageUrl(imgs),
                        name: None,
                        tool_calls: None,
                        tool_call_id: None,
                    });
                }
            }
        }

        // Generate the summary using the LlmClient
        let summary_text = self.llm_client.generate_summary(prompt).await?;

        // Format the final summary message
        let formatted_summary = format!("*Summary from #{channel_name}*\n\n{summary_text}");
        Ok(formatted_summary)
    }
}
