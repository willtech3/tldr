use crate::core::{config::AppConfig, models::ProcessingTask};
use crate::{SlackBot, SlackError};

/// Generate a summary for the given processing task.
///
/// This fetches the relevant messages based on the task
/// configuration and delegates to the SlackBot's
/// summarization logic.
pub async fn summarize_task(
    bot: &mut SlackBot,
    _config: &AppConfig,
    task: &ProcessingTask,
) -> Result<String, SlackError> {
    // Determine channel to get messages from (always the original channel)
    let source_channel_id = &task.channel_id;

    // Get messages based on the parameters
    let mut messages = if let Some(count) = task.message_count {
        // If count is specified, always get the last N messages regardless of read/unread status
        bot.slack_client()
            .get_recent_messages(source_channel_id, count)
            .await?
    } else {
        // If no count specified, default to unread messages (traditional behavior)
        bot.slack_client()
            .get_unread_messages(source_channel_id)
            .await?
    };

    // If visible/public flag is used, filter out the bot's own messages
    // This prevents the bot's response from being included in the summary
    if task.visible || task.dest_public_post {
        // Get the bot's own user ID
        if let Ok(bot_id) = bot.slack_client().get_bot_user_id().await {
            // Filter out messages from the bot
            messages.retain(|msg| {
                if let Some(user_id) = &msg.sender.user {
                    user_id.0 != bot_id
                } else {
                    true
                }
            });
        }
    }

    if messages.is_empty() {
        return Err(SlackError::GeneralError(
            "No messages found to summarize.".to_string(),
        ));
    }

    bot.llm_client()
        .generate_summary(
            bot.llm_client().build_prompt(
                &format!(
                    "Summarize {} messages from channel {}",
                    messages.len(),
                    source_channel_id
                ),
                task.custom_prompt.as_deref(),
            ),
            source_channel_id,
        )
        .await
}
