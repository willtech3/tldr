#![allow(clippy::too_many_lines)]
#![allow(clippy::missing_errors_doc)]
use crate::core::config::AppConfig;
use crate::core::models::ProcessingTask;
use crate::errors::SlackError;
use crate::slack::SlackBot;

pub async fn summarize_task(
    slack_bot: &mut SlackBot,
    config: &AppConfig,
    task: &ProcessingTask,
) -> Result<Option<String>, SlackError> {
    let source_channel_id = &task.channel_id;

    let mut messages = if let Some(count) = task.message_count {
        slack_bot
            .slack_client()
            .get_recent_messages(source_channel_id, count)
            .await?
    } else {
        slack_bot
            .slack_client()
            .get_unread_messages(source_channel_id)
            .await?
    };

    if (task.visible || task.dest_public_post)
        && let Ok(bot_id) = slack_bot.slack_client().get_bot_user_id().await
    {
        messages.retain(|msg| {
            if let Some(user_id) = &msg.sender.user {
                user_id.0 != bot_id
            } else {
                true
            }
        });
    }

    if messages.is_empty() {
        return Ok(None);
    }

    let summary = slack_bot
        .summarize_messages_with_chatgpt(
            config,
            &messages,
            source_channel_id,
            task.custom_prompt.as_deref(),
        )
        .await?;
    Ok(Some(summary))
}
