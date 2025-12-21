use super::client::SlackClient;
use crate::ai::LlmClient;
use futures::future::join_all;
use openai_api_rs::v1::chat_completion::{
    self as chat_completion, ChatCompletionMessage, Content, ContentType, ImageUrl, ImageUrlType,
    MessageRole,
};
use openssl::base64;
use serde_json::Value;
use slack_morphism::{SlackFile, SlackHistoryMessage};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use tracing::{error, info};
use url::Url;

use crate::core::config::AppConfig;
use crate::errors::SlackError;
use crate::utils::links;

#[derive(Clone, Debug)]
struct ReceiptSeed {
    ts: String,
    author: String,
    snippet: String,
}

#[derive(Clone, Debug)]
struct Receipt {
    permalink: String,
    author: String,
    snippet: String,
}

/// Prompt + context returned from `build_summarize_prompt_data`.
///
/// This is used by both the non-streaming and streaming summarization paths.
pub(crate) struct SummarizePromptData {
    pub(crate) prompt: Vec<ChatCompletionMessage>,
    pub(crate) links_shared: Vec<String>,
    pub(crate) receipt_permalinks: Vec<String>,
    pub(crate) has_any_images: bool,
}

fn format_links_context(links: &[String]) -> String {
    if links.is_empty() {
        "Links shared (deduped):\n- None\n".to_string()
    } else {
        let mut s = String::from("Links shared (deduped):\n");
        for l in links.iter().take(20) {
            let _ = writeln!(s, "- {l}");
        }
        s
    }
}

fn format_receipts_context(receipts: &[Receipt]) -> String {
    if receipts.is_empty() {
        "Receipts (permalinks to original Slack messages):\n- None\n".to_string()
    } else {
        let mut s = String::from("Receipts (permalinks to original Slack messages):\n");
        for r in receipts.iter().take(8) {
            if r.snippet.is_empty() {
                let _ = writeln!(s, "- {} — {}", r.permalink, r.author);
            } else {
                let _ = writeln!(s, "- {} — {}: \"{}\"", r.permalink, r.author, r.snippet);
            }
        }
        s
    }
}

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

    pub(crate) fn apply_safety_net_sections(summary_text: &mut String, data: &SummarizePromptData) {
        // Safety net: ensure required sections exist even if the model omits them.
        // We keep these minimal; the richer rendering is expected to come from the model output.
        if !summary_text.to_ascii_lowercase().contains("links shared") {
            summary_text.push_str("\n\n*Links shared*\n");
            if data.links_shared.is_empty() {
                summary_text.push_str("- None\n");
            } else {
                for l in data.links_shared.iter().take(20) {
                    let _ = writeln!(summary_text, "- {l}");
                }
            }
        }

        if !summary_text
            .to_ascii_lowercase()
            .contains("image highlights")
        {
            summary_text.push_str("\n\n*Image highlights*\n");
            if data.has_any_images {
                summary_text.push_str("- (No image highlights provided.)\n");
            } else {
                summary_text.push_str("- None\n");
            }
        }

        if !summary_text.to_ascii_lowercase().contains("receipts") {
            summary_text.push_str("\n\n*Receipts*\n");
            if data.receipt_permalinks.is_empty() {
                summary_text.push_str("- None\n");
            } else {
                for r in data.receipt_permalinks.iter().take(8) {
                    let _ = writeln!(summary_text, "- {r}");
                }
            }
        }
    }

    /// Build the `OpenAI` prompt (and supporting safety-net context) for summarization.
    ///
    /// This encapsulates the "fetch messages → build prompt" logic so the worker can reuse it for
    /// both non-streaming and streaming `OpenAI` calls without duplicating Slack-side processing.
    ///
    /// # Errors
    ///
    /// Returns an error if Slack API calls required for prompt construction fail.
    #[allow(clippy::too_many_lines)]
    pub(crate) async fn build_summarize_prompt_data(
        &mut self,
        messages: &[SlackHistoryMessage],
        channel_id: &str,
        custom_prompt: Option<&str>,
    ) -> Result<SummarizePromptData, SlackError> {
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

        // Extract links shared (URLs + Slack link markup + best-effort block scanning)
        let links_shared = links::extract_links_from_messages(messages);

        // Build a set of message receipts (permalinks) to support trust.
        // We prefer messages that contained links or files, falling back to the newest N messages.
        let author_for = |msg: &SlackHistoryMessage| -> String {
            let user_id = msg
                .sender
                .user
                .as_ref()
                .map_or("Unknown User", |uid| uid.as_ref());

            if user_id == "Unknown User" {
                user_id.to_string()
            } else {
                user_info_cache
                    .get(user_id)
                    .map_or_else(|| user_id.to_string(), std::clone::Clone::clone)
            }
        };

        let snippet_for = |msg: &SlackHistoryMessage| -> String {
            let raw = msg.content.text.as_deref().unwrap_or("").replace('\n', " ");
            // Keep snippets short and safe for Slack formatting.
            let clipped: String = if raw.chars().count() > 80 {
                raw.chars().take(77).collect()
            } else {
                raw
            };
            clipped.replace('`', "'").trim().to_string()
        };

        let mut receipt_seeds: Vec<ReceiptSeed> = Vec::new();
        for msg in messages {
            let has_files = msg.content.files.as_ref().is_some_and(|fs| !fs.is_empty());
            let has_links = !links::extract_links_from_message(msg).is_empty();
            if has_files || has_links {
                receipt_seeds.push(ReceiptSeed {
                    ts: msg.origin.ts.0.clone(),
                    author: author_for(msg),
                    snippet: snippet_for(msg),
                });
            }
        }

        if receipt_seeds.is_empty() {
            for msg in messages.iter().take(8) {
                receipt_seeds.push(ReceiptSeed {
                    ts: msg.origin.ts.0.clone(),
                    author: author_for(msg),
                    snippet: snippet_for(msg),
                });
            }
        }

        if receipt_seeds.len() > 8 {
            receipt_seeds.truncate(8);
        }

        let slack_client = &self.slack_client;
        let fetches = receipt_seeds.iter().map(|seed| async move {
            let res = slack_client
                .get_message_permalink(channel_id, &seed.ts)
                .await;
            (seed, res)
        });

        let mut receipts: Vec<Receipt> = Vec::new();
        for (seed, res) in join_all(fetches).await {
            match res {
                Ok(permalink) => receipts.push(Receipt {
                    permalink,
                    author: seed.author.clone(),
                    snippet: seed.snippet.clone(),
                }),
                Err(e) => {
                    error!(
                        "Failed to fetch message permalink for ts {} in channel {}: {}",
                        seed.ts, channel_id, e
                    );
                }
            }
        }

        let receipt_permalinks: Vec<String> =
            receipts.iter().map(|r| r.permalink.clone()).collect();

        // Build the full prompt using the new method with channel context.
        // We include the extracted "Links shared" and "Receipts" so the model can present
        // them without hallucinating URLs.
        let messages_text = format!(
            "Channel: #{}\n\nMessages:\n{}\n\n{}\n\n{}",
            channel_name,
            formatted_messages.join("\n"),
            format_links_context(&links_shared),
            format_receipts_context(&receipts),
        );

        // 1. Base text portion
        let mut prompt = self.build_prompt(&messages_text, custom_prompt);

        // 2. Append image data so the model can see pictures
        let mut has_any_images = false;
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

                        // Option A: Download the image from Slack using bot auth and inline it
                        // as a Base64 data URL so OpenAI does not need to fetch from Slack.
                        //
                        // This avoids "Error while downloading ..." failures from OpenAI when
                        // Slack URLs are not publicly reachable.
                        let inline_max = self.llm_client.get_inline_image_max_bytes();

                        // Best-effort HEAD validation (content-type + size) on private URL
                        if let Ok(Some((ct_opt, size_opt))) =
                            self.slack_client.fetch_image_head(url.as_str()).await
                        {
                            if let Some(ct) = ct_opt {
                                let ct_can = crate::ai::client::canonicalize_mime(&ct);
                                if !ct_can.starts_with("image/")
                                    || !self.llm_client.is_allowed_image_mime(&ct_can)
                                {
                                    continue;
                                }
                            }

                            if let Some(sz) = size_opt
                                && sz > inline_max
                            {
                                info!(
                                    "Skipping image {} because size {}B > inline cap {}B",
                                    url, sz, inline_max
                                );
                                continue;
                            }
                        }

                        match self
                            .slack_client
                            .download_image_bytes(url.as_str(), inline_max)
                            .await
                        {
                            Ok(bytes) => {
                                let b64 = base64::encode_block(&bytes);
                                let data_url = format!("data:{canon};base64,{b64}");
                                imgs.push(ImageUrl {
                                    r#type: ContentType::image_url,
                                    text: None,
                                    image_url: Some(ImageUrlType { url: data_url }),
                                });
                            }
                            Err(e) => {
                                error!("Failed to download/inline image {}: {}", url, e);
                            }
                        }
                    }
                }
                if !imgs.is_empty() {
                    has_any_images = true;
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

        Ok(SummarizePromptData {
            prompt,
            links_shared,
            receipt_permalinks,
            has_any_images,
        })
    }

    /// # Errors
    ///
    /// Returns an error if the `OpenAI` API call fails or Slack API lookups needed
    /// for prompt construction fail.
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

        let mut data = self
            .build_summarize_prompt_data(messages, channel_id, custom_prompt)
            .await?;

        // Generate the summary using the LlmClient
        let prompt = std::mem::take(&mut data.prompt);
        let mut summary_text = self.llm_client.generate_summary(prompt).await?;
        Self::apply_safety_net_sections(&mut summary_text, &data);

        // Format the final summary message. Use a channel mention so Slack renders the name.
        let formatted_summary = format!("*Summary from <#{channel_id}>*\n\n{summary_text}");
        Ok(formatted_summary)
    }
}
