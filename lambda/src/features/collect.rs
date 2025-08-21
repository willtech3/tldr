use slack_morphism::SlackHistoryMessage;

use crate::bot::SlackBot;
use crate::errors::SlackError;

/// Fetch unread messages from a channel using SlackBot helpers.
pub async fn get_unread_messages(
    bot: &SlackBot,
    channel_id: &str,
) -> Result<Vec<SlackHistoryMessage>, SlackError> {
    bot.get_unread_messages(channel_id).await
}

/// Fetch the last `count` messages from a channel using SlackBot helpers.
pub async fn get_last_n_messages(
    bot: &SlackBot,
    channel_id: &str,
    count: u32,
) -> Result<Vec<SlackHistoryMessage>, SlackError> {
    bot.get_last_n_messages(channel_id, count).await
}

