// Keep function focused; consider splitting if it grows significantly.
use crate::core::config::AppConfig;
use crate::core::models::ProcessingTask;
use crate::errors::SlackError;
use crate::slack::SlackBot;

pub enum SummarizeResult {
    Summary {
        text: String,
        message_count: u32,
        custom_prompt: Option<String>,
    },
    NoMessages,
}

/// # Errors
///
/// Returns an error if Slack API calls fail during message retrieval or summarization.
pub async fn summarize_task(
    slack_bot: &mut SlackBot,
    config: &AppConfig,
    task: &ProcessingTask,
) -> Result<SummarizeResult, SlackError> {
    let source_channel_id = &task.channel_id;

    // Determine retrieval mode: always last N for now (defaulting to 50 if not specified)
    let count = task.message_count.unwrap_or(50);
    let mut messages = slack_bot
        .slack_client()
        .get_recent_messages(source_channel_id, count)
        .await?;

    let is_public_or_visible = task.visible || task.dest_public_post;
    if let (true, Ok(bot_id)) = (
        is_public_or_visible,
        slack_bot.slack_client().get_bot_user_id().await,
    ) {
        messages.retain(|msg| {
            if let Some(user_id) = &msg.sender.user {
                user_id.0 != bot_id
            } else {
                true
            }
        });
    }

    if messages.is_empty() {
        return Ok(SummarizeResult::NoMessages);
    }

    let summary = slack_bot
        .summarize_messages_with_chatgpt(
            config,
            &messages,
            source_channel_id,
            task.custom_prompt.as_deref(),
        )
        .await?;
    Ok(SummarizeResult::Summary {
        text: summary,
        message_count: u32::try_from(messages.len()).unwrap_or(u32::MAX),
        custom_prompt: task.custom_prompt.clone(),
    })
}
