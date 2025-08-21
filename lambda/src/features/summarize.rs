use slack_morphism::SlackHistoryMessage;

use crate::bot::SlackBot;
use crate::core::config::AppConfig;
use crate::errors::SlackError;
use openai_api_rs::v1::chat_completion::{Content, ImageUrl, MessageRole};
use url::Url;

/// Generate a summary for the provided messages using the LlmClient, including image handling.
pub async fn summarize(
    bot: &SlackBot,
    _config: &AppConfig,
    messages: &[SlackHistoryMessage],
    channel_id: &str,
    custom_prompt: Option<&str>,
) -> Result<String, SlackError> {
    if messages.is_empty() {
        return Ok("No messages to summarize.".to_string());
    }

    // Resolve channel name
    let channel_name = bot.slack_client().get_channel_name(channel_id).await?;

    // Build messages_markdown with resolved display names
    use std::collections::{HashMap, HashSet};
    let user_ids: HashSet<String> = messages
        .iter()
        .filter_map(|m| {
            m.sender
                .user
                .as_ref()
                .and_then(|u| (u.as_ref() != "Unknown User").then(|| u.as_ref().to_string()))
        })
        .collect();

    let mut user_cache: HashMap<String, String> = HashMap::new();
    for uid in user_ids {
        let name = bot
            .slack_client()
            .get_user_info(&uid)
            .await
            .unwrap_or(uid.clone());
        user_cache.insert(uid, name);
    }

    let formatted: Vec<String> = messages
        .iter()
        .map(|msg| {
            let uid = msg
                .sender
                .user
                .as_ref()
                .map_or("Unknown User", |u| u.as_ref());
            let author = user_cache
                .get(uid)
                .cloned()
                .unwrap_or_else(|| uid.to_string());
            let ts = msg.origin.ts.clone();
            let text = msg.content.text.as_deref().unwrap_or("");
            format!("[{}] {}: {}", ts, author, text)
        })
        .collect();

    let messages_text = format!("Channel: #{}\n\n{}", channel_name, formatted.join("\n"));

    // Build prompt via LlmClient
    let llm = bot.llm_client();
    let mut prompt = llm.build_prompt(&messages_text, custom_prompt);

    // Image handling: append placeholders and image URLs where applicable
    for msg in messages {
        if let Some(files) = &msg.content.files {
            let mut imgs: Vec<ImageUrl> = Vec::new();
            for file in files {
                // Choose best download URL (prefer url_private_download, fallback to url_private)
                let best_url: Option<&Url> = file
                    .url_private_download
                    .as_ref()
                    .or(file.url_private.as_ref());
                if let Some(url) = best_url {
                    // Determine MIME type via canonicalization and support check
                    let raw_mime: String = file
                        .mimetype
                        .as_ref()
                        .map(|m| m.0.clone())
                        .unwrap_or_else(|| {
                            mime_guess::from_path(url.path())
                                .first_or_octet_stream()
                                .essence_str()
                                .to_string()
                        });

                    let canon = crate::clients::llm_client::canonicalize_mime(&raw_mime);
                    if !crate::utils::mime::is_supported_image_mime(&canon) {
                        continue;
                    }

                    let size_opt = bot
                        .slack_client()
                        .fetch_image_size(url.as_str())
                        .await
                        .unwrap_or(None);
                    let url_max = llm.get_url_image_max_bytes();
                    if let Some(sz) = size_opt.filter(|&s| s > url_max) {
                        tracing::info!(
                            "Skipping image {} because size {}B > {}B",
                            url,
                            sz,
                            url_max
                        );
                        continue;
                    }

                    if let Ok(public_url) = bot.slack_client().ensure_public_file_url(file).await {
                        imgs.push(ImageUrl {
                            r#type: openai_api_rs::v1::chat_completion::ContentType::image_url,
                            text: None,
                            image_url: Some(openai_api_rs::v1::chat_completion::ImageUrlType {
                                url: public_url,
                            }),
                        });
                    }
                }
            }

            if !imgs.is_empty() {
                let text_is_empty = msg
                    .content
                    .text
                    .as_ref()
                    .map(|t| t.trim().is_empty())
                    .unwrap_or(true);
                if text_is_empty {
                    let placeholder = if imgs.len() == 1 {
                        "(uploaded an image)".to_string()
                    } else {
                        format!("(uploaded {} images)", imgs.len())
                    };
                    prompt.push(openai_api_rs::v1::chat_completion::ChatCompletionMessage {
                        role: MessageRole::user,
                        content: Content::Text(placeholder),
                        name: None,
                        tool_calls: None,
                        tool_call_id: None,
                    });
                }
                prompt.push(openai_api_rs::v1::chat_completion::ChatCompletionMessage {
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
    let summary_text = llm.generate_summary(prompt, &channel_name).await?;
    Ok(format!(
        "*Summary from #{}*\n\n{}",
        channel_name, summary_text
    ))
}

// removed local helper; use crate::utils::mime::is_supported_image_mime
