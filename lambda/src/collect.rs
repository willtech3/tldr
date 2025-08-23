use slack_morphism::SlackHistoryMessage;

use crate::bot::SlackBot;
use crate::errors::SlackError;
use crate::utils::filters::filter_user_messages;
use tracing::info;

/// Fetch unread messages from a channel and apply user/bot filtering.
pub async fn get_unread_messages(
    bot: &SlackBot,
    channel_id: &str,
) -> Result<Vec<SlackHistoryMessage>, SlackError> {
    // Get channel history since last read using Slack client
    let messages = bot.slack_client().get_unread_messages(channel_id).await?;

    // Try to get bot user ID for filtering
    let bot_user_id = bot.slack_client().get_bot_user_id().await.ok();

    // Filter messages using the consolidated filter function
    let filtered_messages: Vec<_> = filter_user_messages(messages, bot_user_id.as_deref());

    info!(
        "Filtered down to {} user messages for summarization",
        filtered_messages.len()
    );

    Ok(filtered_messages)
}

/// Fetch the last `count` messages from a channel and apply user/bot filtering.
pub async fn get_last_n_messages(
    bot: &SlackBot,
    channel_id: &str,
    count: u32,
) -> Result<Vec<SlackHistoryMessage>, SlackError> {
    // Get recent messages from Slack
    let messages = bot
        .slack_client()
        .get_recent_messages(channel_id, count)
        .await?;

    // Get the bot's own user ID to filter out its messages
    let bot_user_id = bot.slack_client().get_bot_user_id().await.ok();

    // Filter messages using the consolidated filter function and limit to `count`
    let filtered_messages: Vec<_> = filter_user_messages(messages, bot_user_id.as_deref())
        .into_iter()
        .take(count as usize)
        .collect();

    info!(
        "Filtered down to {} user messages for summarization",
        filtered_messages.len()
    );

    Ok(filtered_messages)
}
