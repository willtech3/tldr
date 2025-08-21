use crate::bot::SlackBot;
use crate::errors::SlackError;

/// Send a direct message to a user.
pub async fn send_dm(bot: &SlackBot, user_id: &str, message: &str) -> Result<(), SlackError> {
    bot.send_dm(user_id, message).await
}

/// Send a message to a channel.
pub async fn send_message_to_channel(
    bot: &SlackBot,
    channel_id: &str,
    message: &str,
) -> Result<(), SlackError> {
    bot.send_message_to_channel(channel_id, message).await
}

/// Replace the original slash command message via response_url.
pub async fn replace_original_message(
    bot: &SlackBot,
    response_url: &str,
    text: Option<&str>,
) -> Result<(), SlackError> {
    bot.replace_original_message(response_url, text).await
}
