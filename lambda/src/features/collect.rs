use slack_morphism::prelude::*;
use tracing::{error, info};

use crate::bot::SlackBot;
use crate::errors::SlackError;
use crate::utils::filters::filter_user_messages;

/// Fetch unread messages from a channel using the provided Slack client.
pub async fn get_unread_messages(
    client: &SlackBot,
    channel_id: &str,
) -> Result<Vec<SlackHistoryMessage>, SlackError> {
    client
        .with_retry(|| async {
            let session = crate::bot::SLACK_CLIENT.open_session(client.token());

            let info_req =
                SlackApiConversationsInfoRequest::new(SlackChannelId::new(channel_id.to_string()));
            let channel_info = session.conversations_info(&info_req).await?;
            let last_read_ts = channel_info
                .channel
                .last_state
                .last_read
                .unwrap_or_else(|| SlackTs::new("0.0".to_string()));

            let request = SlackApiConversationsHistoryRequest::new()
                .with_channel(SlackChannelId::new(channel_id.to_string()))
                .with_limit(1000)
                .with_oldest(last_read_ts);

            let result = session.conversations_history(&request).await?;
            let original_message_count = result.messages.len();

            let bot_user_id = client.get_bot_user_id().await.ok();
            let filtered_messages: Vec<_> =
                filter_user_messages(result.messages, bot_user_id.as_deref());

            info!(
                "Fetched {} total messages, filtered down to {} user messages for summarization",
                original_message_count,
                filtered_messages.len()
            );

            Ok(filtered_messages)
        })
        .await
}

/// Fetch the last `count` messages from a channel.
pub async fn get_last_n_messages(
    client: &SlackBot,
    channel_id: &str,
    count: u32,
) -> Result<Vec<SlackHistoryMessage>, SlackError> {
    client
        .with_retry(|| async {
            let session = crate::bot::SLACK_CLIENT.open_session(client.token());

            let bot_user_id = match client.get_bot_user_id().await {
                Ok(id) => Some(id),
                Err(e) => {
                    error!("Failed to get bot user ID for filtering: {}", e);
                    None
                }
            };

            let request = SlackApiConversationsHistoryRequest::new()
                .with_channel(SlackChannelId::new(channel_id.to_string()))
                .with_limit(std::cmp::min(count, 1000) as u16);

            let result = session.conversations_history(&request).await?;
            let original_message_count = result.messages.len();

            let filtered_messages: Vec<_> =
                filter_user_messages(result.messages, bot_user_id.as_deref())
                    .into_iter()
                    .take(count as usize)
                    .collect();

            info!(
                "Fetched {} total messages, filtered down to {} user messages for summarization",
                original_message_count,
                filtered_messages.len()
            );

            Ok(filtered_messages)
        })
        .await
}
