use lambda_runtime::{Error, LambdaEvent};
use reqwest::Client as HttpClient;
use serde_json::Value;
use tracing::{error, info, warn};

use super::summarize::SummarizeResult;
use super::{deliver, streaming, summarize};
use crate::core::config::AppConfig;
use crate::core::models::Destination;
use crate::core::models::ProcessingTask;
use crate::slack::SlackBot;
use crate::slack::sanitize::sanitize_generated_slack_mrkdwn;

/// Lambda handler for the Worker entrypoint. Parses SQS message, summarizes, and delivers.
///
/// # Errors
///
/// Returns an error when configuration loading fails, the SQS payload cannot be
/// parsed, or downstream delivery operations fail.
pub async fn function_handler(event: LambdaEvent<Value>) -> Result<(), Error> {
    let config = AppConfig::from_env_cached().await.map_err(|e| {
        error!("Config error: {}", e);
        Error::from(e)
    })?;
    let record_count = sqs_record_count(&event.payload);
    info!(record_count, "Worker Lambda received SQS event");

    let mut task = parse_processing_task(&event.payload)?;
    task.enforce_runtime_limits();
    log_processing_task(&task);

    if !task.has_valid_source_channel() {
        warn!(
            corr_id = %task.correlation_id,
            "Rejecting task with invalid source channel id"
        );
        return Ok(());
    }

    let mut slack_bot =
        SlackBot::new(config).map_err(|e| Error::from(format!("Failed to initialize bot: {e}")))?;
    let http_client = HttpClient::new();

    if !requester_can_read_source_channel(&slack_bot, &task).await {
        notify_authorization_failure(&slack_bot, &task).await;
        return Ok(());
    }

    // Stream end-to-end into assistant threads when enabled. This path is thread-only.
    //
    // Design note: We intentionally return Ok(()) even on streaming failure to prevent
    // Lambda retries which would cause duplicate user-facing messages. The streaming
    // module handles cleanup internally (via ensure_canonical_failure) to show the user
    // an error message. Failures are logged with correlation_id for monitoring/alerting.
    if config.enable_streaming
        && matches!(task.destination, Destination::Thread)
        && task.thread_ts.is_some()
    {
        if let Err(e) =
            streaming::stream_summary_to_assistant_thread(&mut slack_bot, config, &task).await
        {
            error!(
                event = "tldr_streaming_failed",
                corr_id = %task.correlation_id,
                error = %e,
                "Streaming delivery failed"
            );
        }
        return Ok(());
    }

    match summarize::summarize_task(&mut slack_bot, config, &task).await {
        Ok(SummarizeResult::Summary { text }) => {
            let sanitized_text = sanitize_generated_slack_mrkdwn(&text);
            deliver::deliver_summary(
                &slack_bot,
                &http_client,
                &task,
                &task.channel_id,
                &sanitized_text,
            )
            .await
            .map_err(|e| Error::from(format!("Delivery error: {e}")))?;
        }
        Ok(SummarizeResult::NoMessages) => {
            deliver::notify_no_messages(&slack_bot, &http_client, &task)
                .await
                .map_err(|e| Error::from(format!("Delivery error: {e}")))?;
        }
        Err(e) => {
            error!("Failed to generate summary: {}", e);
            let error_message = super::CANONICAL_FAILURE_MESSAGE;

            // Primary: deliver error to assistant thread if destination is Thread
            if matches!(task.destination, Destination::Thread) {
                if let Some(thread_ts) = &task.thread_ts {
                    let reply_channel = task
                        .origin_channel_id
                        .as_deref()
                        .unwrap_or(&task.channel_id);
                    let _ = slack_bot
                        .slack_client()
                        .post_message_in_thread(reply_channel, thread_ts, error_message)
                        .await;
                }
            } else if task.dest_dm {
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

fn sqs_record_count(payload: &Value) -> usize {
    payload
        .get("Records")
        .and_then(|records| records.as_array())
        .map_or(0, std::vec::Vec::len)
}

fn parse_processing_task(payload: &Value) -> Result<ProcessingTask, Error> {
    payload
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
        })
}

fn log_processing_task(task: &ProcessingTask) {
    info!(
        corr_id = %task.correlation_id,
        destination = ?task.destination,
        has_thread = task.thread_ts.is_some(),
        has_custom_prompt = task.custom_prompt.is_some(),
        message_count = task.message_count.unwrap_or_default(),
        "Successfully parsed ProcessingTask"
    );
}

async fn requester_can_read_source_channel(slack_bot: &SlackBot, task: &ProcessingTask) -> bool {
    match slack_bot
        .slack_client()
        .is_user_member_of_channel(&task.channel_id, &task.user_id)
        .await
    {
        Ok(true) => true,
        Ok(false) => {
            warn!(
                corr_id = %task.correlation_id,
                "Rejecting task because requester is not a member of the source channel"
            );
            false
        }
        Err(e) => {
            error!(
                corr_id = %task.correlation_id,
                error = %e,
                "Failed to verify requester channel membership"
            );
            false
        }
    }
}

async fn notify_authorization_failure(slack_bot: &SlackBot, task: &ProcessingTask) {
    let message = "I can only summarize channels you're a member of.";
    if matches!(task.destination, Destination::Thread) {
        if let Some(thread_ts) = &task.thread_ts {
            let reply_channel = task
                .origin_channel_id
                .as_deref()
                .unwrap_or(&task.channel_id);
            let _ = slack_bot
                .slack_client()
                .post_message_in_thread(reply_channel, thread_ts, message)
                .await;
        }
    } else if task.dest_dm {
        let _ = slack_bot
            .slack_client()
            .send_dm(&task.user_id, message)
            .await;
    }
}

pub use self::function_handler as handler;
