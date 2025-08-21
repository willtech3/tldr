use crate::bot::SlackBot;
use crate::errors::SlackError;
use slack_morphism::prelude::SlackHistoryMessage;

/// Retrieve unread messages from a channel.
pub async fn get_unread_messages(
    bot: &SlackBot,
    channel_id: &str,
) -> Result<Vec<SlackHistoryMessage>, SlackError> {
    bot.get_unread_messages(channel_id).await
}

/// Retrieve the last `count` messages from a channel.
pub async fn get_last_n_messages(
    bot: &SlackBot,
    channel_id: &str,
    count: u32,
) -> Result<Vec<SlackHistoryMessage>, SlackError> {
    bot.get_last_n_messages(channel_id, count).await
}
