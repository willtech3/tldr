use crate::core::{config::AppConfig, models::ProcessingTask};
use crate::errors::SlackError;
use aws_sdk_sqs::Client as SqsClient;

/// # Errors
///
/// Returns an error if serialization fails or the message cannot be sent to SQS.
pub async fn send_to_sqs(task: &ProcessingTask, config: &AppConfig) -> Result<(), SlackError> {
    let queue_url = &config.processing_queue_url;
    let shared_config = aws_config::from_env().load().await;
    let client = SqsClient::new(&shared_config);
    let message_body = serde_json::to_string(task)
        .map_err(|e| SlackError::ApiError(format!("Failed to serialize task: {e}")))?;

    client
        .send_message()
        .queue_url(queue_url)
        .message_body(message_body)
        .send()
        .await
        .map_err(|e| SlackError::AwsError(format!("Failed to send message to SQS: {e}")))?;
    Ok(())
}
