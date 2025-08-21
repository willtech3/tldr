use slack_morphism::SlackHistoryMessage;

use crate::bot::SlackBot;
use crate::core::config::AppConfig;
use crate::errors::SlackError;

/// Generate a summary for the provided messages using the LlmClient.
pub async fn summarize(
    bot: &mut SlackBot,
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
        let name = bot.get_user_info(&uid).await.unwrap_or(uid.clone());
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
            let author = user_cache.get(uid).cloned().unwrap_or_else(|| uid.to_string());
            let ts = msg.origin.ts.clone();
            let text = msg.content.text.as_deref().unwrap_or("");
            format!("[{}] {}: {}", ts, author, text)
        })
        .collect();

    let messages_markdown = format!("Channel: #{}\n\n{}", channel_name, formatted.join("\n"));

    // Build prompt via LlmClient
    let llm = bot.llm_client();
    let prompt = llm.build_prompt(&messages_markdown, custom_prompt);

    // Collect image urls (optional enhancement) — omitted for brevity; bot::summarize handles images already

    let summary_text = llm.generate_summary(prompt, &channel_name).await?;
    Ok(format!("*Summary from #{}*\n\n{}", channel_name, summary_text))
}
