use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::env;
use aws_sdk_sqs::Client as SqsClient;
use aws_config::meta::region::RegionProviderChain;
use tracing::{info, error};
use anyhow::Result;

// Import shared modules
use tldr::{slack_parser::{SlackCommandEvent, parse_form_data}, SlackError};

#[derive(Debug, Serialize, Deserialize)]
struct ProcessingTask {
    user_id: String,
    channel_id: String,
    response_url: String,
    text: String,
}

async fn send_to_sqs(task: &ProcessingTask) -> Result<(), Error> {
    // Get queue URL from environment
    let queue_url = env::var("PROCESSING_QUEUE_URL")
        .map_err(|_| Error::from("PROCESSING_QUEUE_URL environment variable not set"))?;
    
    // Set up AWS SDK
    let region_provider = RegionProviderChain::default_provider().or_else("us-east-1");
    let shared_config = aws_config::from_env().region(region_provider).load().await;
    let client = SqsClient::new(&shared_config);
    
    // Serialize task to JSON string
    let message_body = serde_json::to_string(task)
        .map_err(|e| Error::from(format!("Failed to serialize task: {}", e)))?;
    
    // Use the builder pattern correctly for SQS client
    client.send_message()
        .queue_url(queue_url)
        .message_body(message_body)
        .send()
        .await
        .map_err(|e| Error::from(format!("Failed to send message to SQS: {}", e)))?;
    
    Ok(())
}

fn parse_slack_event(payload: &str) -> Result<SlackCommandEvent, SlackError> {
    // Parse the form-encoded data that Slack sends for slash commands
    parse_form_data(payload)
        .map_err(|e| SlackError::ParseError(format!("Failed to parse form data: {}", e)))
}

async fn function_handler(event: LambdaEvent<String>) -> Result<impl Serialize, Error> {
    let payload = event.payload;
    info!("API Lambda received request: {:?}", payload);

    // Parse the incoming event
    let slack_event = parse_slack_event(&payload).map_err(|e| {
        error!("Failed to parse Slack event: {}", e);
        Error::from(format!("Parse Error: {}", e))
    })?;
    
    // Create processing task
    let task = ProcessingTask {
        user_id: slack_event.user_id.clone(),
        channel_id: slack_event.channel_id.clone(),
        response_url: slack_event.response_url.clone(),
        text: slack_event.text.clone(),
    };
    
    // Send to SQS for async processing
    if let Err(e) = send_to_sqs(&task).await {
        error!("Failed to send to SQS: {}", e);
        return Ok(json!({
            "response_type": "ephemeral",
            "text": "Sorry, I couldn't process your request at this time. Please try again later."
        }));
    }
    
    // Return immediate response to Slack
    info!("Task sent to processing queue successfully");
    Ok(json!({
        "response_type": "ephemeral",
        "text": "Processing your request. I'll send you a summary of unread messages shortly!"
    }))
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    // Initialize tracing
    tracing_subscriber::fmt::init();
    
    // Run the Lambda function
    run(service_fn(function_handler)).await
}
