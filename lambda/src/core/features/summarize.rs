use crate::bot::SlackBot;
use crate::core::config::AppConfig;
use crate::errors::SlackError;
use slack_morphism::prelude::SlackHistoryMessage;

/// Summarize a collection of messages using the LLM client.
pub async fn summarize(
    bot: &mut SlackBot,
    config: &AppConfig,
    messages: &[SlackHistoryMessage],
    channel_id: &str,
    custom_prompt: Option<&str>,
) -> Result<String, SlackError> {
    bot.summarize_messages_with_chatgpt(config, messages, channel_id, custom_prompt)
        .await
}
