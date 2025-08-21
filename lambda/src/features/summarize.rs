use slack_morphism::SlackHistoryMessage;

use crate::bot::SlackBot;
use crate::core::config::AppConfig;
use crate::errors::SlackError;

/// Generate a summary for the provided messages.
pub async fn summarize(
    client: &mut SlackBot,
    config: &AppConfig,
    messages: &[SlackHistoryMessage],
    channel_id: &str,
    custom_prompt: Option<&str>,
) -> Result<String, SlackError> {
    client
        .summarize_messages_with_chatgpt(config, messages, channel_id, custom_prompt)
        .await
}
