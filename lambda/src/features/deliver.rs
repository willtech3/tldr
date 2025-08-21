use crate::bot::SlackBot;
use crate::errors::SlackError;

/// Send a direct message to a user.
pub async fn send_dm(client: &SlackBot, user_id: &str, message: &str) -> Result<(), SlackError> {
    client.send_dm(user_id, message).await
}

/// Send a message to a channel.
pub async fn send_message_to_channel(
    client: &SlackBot,
    channel_id: &str,
    message: &str,
) -> Result<(), SlackError> {
    client.send_message_to_channel(channel_id, message).await
}
