use super::client::SlackClient;
use super::response_builder::create_replace_original_payload;
use crate::ai::LlmClient;
use futures::future::join_all;
use openai_api_rs::v1::chat_completion::{
    self as chat_completion, ChatCompletionMessage, Content, ContentType, ImageUrl, ImageUrlType,
    MessageRole,
};
use serde_json::Value;
use slack_morphism::{SlackFile, SlackHistoryMessage};
use std::collections::{HashMap, HashSet};
use tracing::{debug, error, info};
use url::Url;

use crate::core::config::AppConfig;
use crate::errors::SlackError;

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

    async fn fetch_image_size(&self, url: &str) -> Result<Option<usize>, SlackError> {
        self.slack_client.fetch_image_size(url).await
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

        // Prefer the original /download/ path (direct already has it).
        // Slack frequently returns text/html for HEAD on public files, even when GET serves the image.
        // Since we already validated allowed image types earlier using Slack metadata or path extension,
        // and we've attached a valid pub_secret, return the constructed URL without strict HEAD checks.
        // As a safety net, if clients later fail to fetch, Slack will log it; we avoid precluding valid cases here.
        Ok(direct.to_string())
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

        // Fetch all user info concurrently and build a cache
        let slack_client = &self.slack_client;
        let fetches = user_ids
            .iter()
            .map(|uid| async move { (uid.clone(), slack_client.get_user_info(uid).await) });

        let mut user_info_cache = HashMap::new();
        for (uid, res) in join_all(fetches).await {
            match res {
                Ok(name) => {
                    user_info_cache.insert(uid, name);
                }
                Err(e) => {
                    error!("Failed to get user info for {}: {}", uid, e);
                    user_info_cache.insert(uid.clone(), uid);
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

                        // Server-side HEAD validation on private URL with bot token
                        let head_info = self
                            .slack_client
                            .fetch_image_head(url.as_str())
                            .await
                            .unwrap_or(None);

                        // If HEAD succeeded, ensure content-type is image/* and enforce size limit
                        if let Some((ct_opt, size_opt)) = head_info {
                            if let Some(ct) = ct_opt {
                                let ct_can = crate::ai::client::canonicalize_mime(&ct);
                                if !ct_can.starts_with("image/")
                                    || !self.llm_client.is_allowed_image_mime(&ct_can)
                                {
                                    // Not an image; skip this file entirely
                                    continue;
                                }
                            }

                            // Skip if over OpenAI hard limit
                            if let Some(sz) = size_opt {
                                let url_max = self.llm_client.get_url_image_max_bytes();
                                if sz > url_max {
                                    info!(
                                        "Skipping image {} because size {}B > {}B",
                                        url, sz, url_max
                                    );
                                    continue;
                                }
                            }
                        }

                        let size_opt = self.fetch_image_size(url.as_str()).await.unwrap_or(None);

                        // Skip if over OpenAI hard limit
                        let url_max = self.llm_client.get_url_image_max_bytes();
                        if let Some(sz) = size_opt.filter(|&s| s > url_max) {
                            info!("Skipping image {} because size {}B > {}B", url, sz, url_max);
                            continue;
                        }

                        // Always use an http(s) URL for the model. Avoid data URIs.
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
                if !imgs.is_empty() {
                    // Cap total images to avoid invalid_request_error and huge payloads
                    let cap = self.llm_client.get_max_images_total();
                    if imgs.len() > cap {
                        imgs.truncate(cap);
                    }
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

        // Format the final summary message. Use a channel mention so Slack renders the name.
        let formatted_summary = format!("*Summary from <#{channel_id}>*\n\n{summary_text}");
        Ok(formatted_summary)
    }
}
