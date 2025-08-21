use crate::core::{config::AppConfig, models::ProcessingTask};
use crate::{SlackBot, SlackError};

/// Summarize messages for the provided task.
///
/// Returns `Ok(Some(summary))` when a summary was generated,
/// `Ok(None)` when there were no messages to summarize,
/// or `Err` if generation failed.
#[allow(clippy::too_many_lines)]
pub async fn summarize(
    bot: &mut SlackBot,
    config: &AppConfig,
    task: &ProcessingTask,
) -> Result<Option<String>, SlackError> {
    let source_channel_id = &task.channel_id;

    // Get messages based on task parameters
    let mut messages = if let Some(count) = task.message_count {
        bot.get_last_n_messages(source_channel_id, count).await?
    } else {
        bot.get_unread_messages(source_channel_id).await?
    };

    // Filter out the bot's own messages when posting publicly
    if task.visible || task.dest_public_post {
        if let Ok(bot_user_id) = bot.get_bot_user_id().await {
            messages.retain(|msg| {
                msg.sender
                    .user
                    .as_ref()
                    .map(|u| u.0 != bot_user_id)
                    .unwrap_or(true)
            });
        }
    }

    if messages.is_empty() {
        return Ok(None);
    }

    let summary = bot
        .summarize_messages_with_chatgpt(
            config,
            &messages,
            source_channel_id,
            task.custom_prompt.as_deref(),
        )
        .await?;

    Ok(Some(summary))
}
