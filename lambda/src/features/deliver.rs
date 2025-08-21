use crate::bot::SlackBot;
use crate::canvas::CanvasHelper;
use crate::errors::SlackError;
use tracing::info;

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

/// Ensure a Canvas exists for a channel and prepend a summary section.
pub async fn deliver_to_canvas(
    client: &SlackBot,
    channel_id: &str,
    heading: &str,
    content: &str,
) -> Result<(), SlackError> {
    let helper = CanvasHelper::new(client.slack_client());
    let canvas_id = helper.ensure_channel_canvas(channel_id).await?;
    info!("Updating Canvas {} for channel {}", canvas_id, channel_id);
    helper
        .prepend_summary_section(&canvas_id, heading, content)
        .await?;
    Ok(())
}
