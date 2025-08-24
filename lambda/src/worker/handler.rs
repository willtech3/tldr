// The handler is long due to Lambda event plumbing and branching; split later if it grows further.
use lambda_runtime::{Error, LambdaEvent};
use reqwest::Client as HttpClient;
use serde_json::Value;
use tracing::{error, info};

use super::summarize::SummarizeResult;
use super::{deliver, summarize};
use crate::core::config::AppConfig;
use crate::core::models::ProcessingTask;
use crate::slack::SlackBot;

/// Lambda handler for the Worker entrypoint. Parses SQS message, summarizes, and delivers.
///
/// # Errors
///
/// Returns an error when configuration loading fails, the SQS payload cannot be
/// parsed, or downstream delivery operations fail.
pub async fn function_handler(event: LambdaEvent<Value>) -> Result<(), Error> {
    let config = AppConfig::from_env().map_err(|e| {
        error!("Config error: {}", e);
        Error::from(e)
    })?;
    info!(
        "Worker Lambda received SQS event payload: {:?}",
        event.payload
    );

    let task: ProcessingTask = event
        .payload
        .get("Records")
        .and_then(|records| records.as_array())
        .and_then(|records| records.first())
        .and_then(|record| record.get("body"))
        .and_then(|body| body.as_str())
        .ok_or_else(|| Error::from("Failed to extract SQS message body"))
        .and_then(|body_str| {
            serde_json::from_str(body_str).map_err(|e| {
                Error::from(format!(
                    "Failed to parse SQS message body into ProcessingTask: {e}"
                ))
            })
        })?;

    info!("Successfully parsed ProcessingTask: {:?}", task);

    let mut slack_bot = SlackBot::new(&config)
        .map_err(|e| Error::from(format!("Failed to initialize bot: {e}")))?;
    let http_client = HttpClient::new();

    match summarize::summarize_task(&mut slack_bot, &config, &task).await {
        Ok(SummarizeResult::Summary(summary)) => {
            deliver::deliver_summary(&slack_bot, &http_client, &task, &task.channel_id, &summary)
                .await
                .map_err(|e| Error::from(format!("Delivery error: {e}")))?;
        }
        Ok(SummarizeResult::NoMessages) => {
            deliver::notify_no_messages(&slack_bot, &http_client, &task)
                .await
                .map_err(|e| Error::from(format!("Delivery error: {e}")))?;
        }
        Ok(SummarizeResult::OAuthInitiated) => {
            // OAuth flow was initiated, DM already sent by summarize_task
            // Don't send any additional messages
            info!(
                "OAuth flow initiated for user {}, no summary generated",
                task.user_id
            );
        }
        Err(e) => {
            error!("Failed to generate summary: {}", e);
            let error_message =
                "Sorry, I couldn't generate a summary at this time. Please try again later.";
            if task.dest_dm {
                let _ = slack_bot
                    .slack_client()
                    .send_dm(&task.user_id, error_message)
                    .await;
            } else if let Some(resp_url) = &task.response_url {
                deliver::send_response_url(
                    &http_client,
                    &slack_bot,
                    resp_url,
                    error_message,
                    Some(&task.user_id),
                )
                .await
                .map_err(|e| Error::from(format!("Delivery error: {e}")))?;
            }
        }
    }

    Ok(())
}

pub use self::function_handler as handler;
