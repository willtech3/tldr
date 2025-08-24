// Keep function focused; consider splitting if it grows significantly.
use crate::core::config::AppConfig;
use crate::core::models::ProcessingTask;
use crate::core::user_tokens::{get_user_token, has_user_been_notified, mark_user_notified};
use crate::errors::SlackError;
use crate::slack::SlackBot;

/// # Errors
///
/// Returns an error if Slack API calls fail during message retrieval or summarization.
pub async fn summarize_task(
    slack_bot: &mut SlackBot,
    config: &AppConfig,
    task: &ProcessingTask,
) -> Result<Option<String>, SlackError> {
    let source_channel_id = &task.channel_id;

    // Determine retrieval mode: last N vs all unread (user-specific)
    let mut messages = if let Some(count) = task.message_count {
        // Last N using bot token
        slack_bot
            .slack_client()
            .get_recent_messages(source_channel_id, count)
            .await?
    } else {
        // All unread for the requesting user: prefer user token; fallback to last N=100
        if let Some(stored) = get_user_token(config, &task.user_id).await? {
            let user_client =
                crate::slack::client::SlackClient::from_user_token(stored.access_token);
            user_client.get_unread_messages(source_channel_id).await?
        } else {
            // No user token: fallback to last 100 messages and send one-time DM with auth link
            let need_notify = !has_user_been_notified(config, &task.user_id).await?;
            if need_notify {
                let base = std::env::var("API_BASE_URL")
                    .unwrap_or_else(|_| "https://example.com".to_string());
                let auth_url = format!("{base}/auth/slack/start");
                let msg = format!(
                    "For accurate 'All unread' summaries, connect your Slack account: {auth_url}"
                );
                let _ = slack_bot
                    .slack_client()
                    .send_dm(&task.user_id, &msg)
                    .await;
                let _ = mark_user_notified(config, &task.user_id).await;
            }

            slack_bot
                .slack_client()
                .get_recent_messages(source_channel_id, 100)
                .await?
        }
    };

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
