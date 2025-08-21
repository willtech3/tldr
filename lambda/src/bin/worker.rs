#![allow(clippy::missing_errors_doc)]
#![allow(clippy::uninlined_format_args)]

use lambda_runtime::{Error, LambdaEvent};
use reqwest::Client as HttpClient;
use serde_json::Value;
use tldr::core::{config::AppConfig, models::ProcessingTask};
use tldr::features::{deliver, summarize};
use tldr::{SlackBot, SlackError};
use tracing::{error, info};

pub use self::function_handler as handler;

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
                    "Failed to parse SQS message body into ProcessingTask: {}",
                    e
                ))
            })
        })?;

    info!("Successfully parsed ProcessingTask: {:?}", task);

    let mut slack_bot = SlackBot::new(&config)
        .await
        .map_err(|e| Error::from(format!("Failed to initialize bot: {}", e)))?;
    let http_client = HttpClient::new();

    match summarize::summarize_task(&mut slack_bot, &config, &task).await {
        Ok(summary) => {
            if let Err(e) =
                deliver::deliver_summary(&slack_bot, &http_client, &task, &summary).await
            {
                error!("Failed to deliver summary: {}", e);
                deliver::deliver_error(
                    &slack_bot,
                    &http_client,
                    &task,
                    "Sorry, I couldn't deliver the summary. Please try again.",
                )
                .await?;
            }
        }
        Err(e) => {
            error!("Failed to generate summary: {}", e);
            let msg = match e {
                SlackError::GeneralError(ref m) => m.clone(),
                _ => "Sorry, I couldn't generate a summary at this time. Please try again later."
                    .to_string(),
            };
            deliver::deliver_error(&slack_bot, &http_client, &task, &msg).await?;
        }
    }

    Ok(())
}

#[tokio::main]
#[allow(dead_code)]
async fn main() -> Result<(), Error> {
    tldr::setup_logging();
    lambda_runtime::run(lambda_runtime::service_fn(function_handler)).await?;
    Ok(())
}
