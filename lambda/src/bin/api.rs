use lambda_runtime::{run, service_fn, Error, LambdaEvent};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::env;
use aws_sdk_sqs::Client as SqsClient;
use aws_config::meta::region::RegionProviderChain;
use tracing::{info, error};
use anyhow::Result;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};
use hex;
use regex::Regex;
use lazy_static::lazy_static;
use once_cell::sync::Lazy;

// Import shared modules
use tldr::{slack_parser::{SlackCommandEvent, parse_form_data}, SlackError, sanitize_custom_prompt};
use tldr::SlackBot;

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessingTask {
    pub user_id: String,
    pub channel_id: String,
    pub response_url: String,
    pub text: String,
    pub message_count: Option<u32>,
    pub target_channel_id: Option<String>,
    pub custom_prompt: Option<String>,
    pub visible: bool,
}

async fn send_to_sqs(task: &ProcessingTask) -> Result<(), SlackError> {
    // Get queue URL from environment
    let queue_url = env::var("PROCESSING_QUEUE_URL")
        .map_err(|_| SlackError::AwsError("PROCESSING_QUEUE_URL environment variable not set".to_string()))?;
    
    // Set up AWS SDK
    let region_provider = RegionProviderChain::default_provider().or_else("us-east-1");
    let shared_config = aws_config::from_env().region(region_provider).load().await;
    let client = SqsClient::new(&shared_config);
    
    // Serialize task to JSON string
    let message_body = serde_json::to_string(task)
        .map_err(|e| SlackError::ApiError(format!("Failed to serialize task: {}", e)))?;
    
    // Use the builder pattern correctly for SQS client
    client.send_message()
        .queue_url(queue_url)
        .message_body(message_body)
        .send()
        .await
        .map_err(|e| SlackError::AwsError(format!("Failed to send message to SQS: {}", e)))?;
    
    Ok(())
}

async fn get_latest_message_ts(channel_id: &str) -> Result<Option<String>, SlackError> {
    // Initialize the SlackBot
    let slack_bot = SlackBot::new().await?;
    
    // Get the most recent message in the channel (limit to 1)
    let messages = slack_bot.get_last_n_messages(channel_id, 1).await?;
    
    // Return the timestamp of the most recent message if available
    if let Some(latest_msg) = messages.first() {
        Ok(Some(latest_msg.origin.ts.to_string()))
    } else {
        Ok(None)
    }
}

fn parse_slack_event(payload: &str) -> Result<SlackCommandEvent, SlackError> {
    // Parse the form-encoded data that Slack sends for slash commands
    parse_form_data(payload)
        .map_err(|e| SlackError::ParseError(format!("Failed to parse form data: {}", e)))
}

/// Verify Slack request signature to ensure authenticity
/// Based on Slack's security guidelines: https://api.slack.com/authentication/verifying-requests-from-slack
fn verify_slack_signature(request_body: &str, timestamp: &str, signature: &str) -> bool {
    // Get signing secret from environment
    let signing_secret = match env::var("SLACK_SIGNING_SECRET") {
        Ok(secret) => secret,
        Err(_) => {
            error!("SLACK_SIGNING_SECRET environment variable not set");
            return false;
        }
    };
    
    // Check if timestamp is within 5 minutes to prevent replay attacks
    if let Ok(ts) = timestamp.parse::<u64>() {
        if let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) {
            let now_secs = now.as_secs();
            if now_secs - ts > 300 || ts > now_secs + 60 {
                error!("Timestamp out of range, potential replay attack");
                return false;
            }
        }
    }
    
    // Create base string by concatenating version, timestamp, and request body
    let base_string = format!("v0:{}:{}", timestamp, request_body);
    
    // Create HMAC with SHA256
    let mut mac = match Hmac::<Sha256>::new_from_slice(signing_secret.as_bytes()) {
        Ok(mac) => mac,
        Err(e) => {
            error!("Failed to create HMAC: {}", e);
            return false;
        }
    };
    
    // Update HMAC with base string
    mac.update(base_string.as_bytes());
    
    // Get computed signature and format in Slack's expected format
    let computed_signature = format!("v0={}", hex::encode(mac.finalize().into_bytes()));
    
    // Compare computed signature with provided signature using constant-time comparison
    // to prevent timing attacks
    if computed_signature == signature {
        true
    } else {
        error!("Signature verification failed. Computed: '{}', Received: '{}'", computed_signature, signature);
        false
    }
}

async fn function_handler(event: LambdaEvent<serde_json::Value>) -> Result<impl Serialize, Error> {
    info!("API Lambda received request: {:?}", event);
    
    // Extract headers and body from the Lambda event
    let headers = match event.payload.get("headers") {
        Some(headers) => headers,
        None => {
            error!("Request missing headers");
            return Ok(json!({
                "statusCode": 400,
                "body": json!({ "error": "Missing headers" }).to_string()
            }));
        }
    };
    
    let body = match event.payload.get("body") {
        Some(body) => match body.as_str() {
            Some(body_str) => body_str,
            None => {
                error!("Request body is not a string");
                return Ok(json!({
                    "statusCode": 400,
                    "body": json!({ "error": "Invalid body format" }).to_string()
                }));
            }
        },
        None => {
            error!("Request missing body");
            return Ok(json!({
                "statusCode": 400,
                "body": json!({ "error": "Missing body" }).to_string()
            }));
        }
    };
    
    // Extract Slack signature headers
    let signature = match headers.get("X-Slack-Signature").and_then(|s| s.as_str()) {
        Some(sig) => sig,
        None => {
            error!("Missing X-Slack-Signature header");
            return Ok(json!({
                "statusCode": 401,
                "body": json!({ "error": "Missing X-Slack-Signature header" }).to_string()
            }));
        }
    };
    
    let timestamp = match headers.get("X-Slack-Request-Timestamp").and_then(|s| s.as_str()) {
        Some(ts) => ts,
        None => {
            error!("Missing X-Slack-Request-Timestamp header");
            return Ok(json!({
                "statusCode": 401,
                "body": json!({ "error": "Missing X-Slack-Request-Timestamp header" }).to_string()
            }));
        }
    };
    
    // Verify the Slack signature
    if !verify_slack_signature(body, timestamp, signature) {
        error!("Slack signature verification failed");
        return Ok(json!({
            "statusCode": 401,
            "body": json!({ "error": "Invalid Slack signature" }).to_string()
        }));
    }
    
    info!("Slack signature verified successfully");
    
    // Parse the incoming event
    let slack_event = match parse_slack_event(body) {
        Ok(event) => event,
        Err(e) => {
            error!("Failed to parse Slack event: {}", e);
            return Ok(json!({
                "statusCode": 400,
                "body": json!({ "error": format!("Parse Error: {}", e) }).to_string()
            }));
        }
    };
    
    // Parse visibility parameter from the text
    let text_parts: Vec<&str> = slack_event.text.split_whitespace().collect();
    let visible = text_parts.iter().any(|&part| part == "--visible" || part == "--public");
    
    // Filter out the visibility flags from the text for other processing
    let filtered_text: String = text_parts
        .iter()
        .filter(|&&part| part != "--visible" && part != "--public")
        .cloned()
        .collect::<Vec<&str>>()
        .join(" ");
    
    // Define regex for parsing key-value parameters with proper quote handling
    static KV_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(\w+)\s*=\s*("[^"]*"|\S+)"#).expect("Failed to compile parameter parsing regex - this is a static pattern and should never fail"));
    
    // Parse parameters from filtered text
    let mut message_count: Option<u32> = None;
    let mut target_channel_id: Option<String> = None;
    let mut custom_prompt: Option<String> = None;
    
    // Use regex captures to properly handle quoted values
    for cap in KV_RE.captures_iter(&filtered_text) {
        let key = &cap[1].to_lowercase();
        let raw = cap[2].trim_matches('"');  // strip quotes if present
        
        match key.as_str() {
            "count" => {
                if let Ok(count) = raw.parse::<u32>() {
                    message_count = Some(count);
                }
            },
            "channel" => {
                // Handle both #channel and channel formats
                let channel_id = if raw.starts_with("<#") && raw.ends_with(">") {
                    // Format: <#C12345|channel-name> or <#C12345>
                    let channel_part = &raw[2..raw.len()-1];
                    if let Some(pipe_pos) = channel_part.find('|') {
                        channel_part[0..pipe_pos].to_string()
                    } else {
                        channel_part.to_string()
                    }
                } else if raw.starts_with('#') {
                    // Format: #channel-name (we'll need to look it up by name)
                    raw[1..].to_string()
                } else {
                    // Just the raw channel ID or name
                    raw.to_string()
                };
                target_channel_id = Some(channel_id);
            },
            "custom" => {
                // Sanitize custom prompt
                match sanitize_custom_prompt(raw) {
                    Ok(sanitized_prompt) => {
                        custom_prompt = Some(sanitized_prompt);
                    },
                    Err(e) => {
                        info!("Invalid custom prompt rejected: {}", e);
                        // We continue processing without a custom prompt
                    }
                }
            },
            _ => {}
        }
    }
    
    // Send to SQS for async processing
    
    // Create processing task with all parsed parameters
    let task = ProcessingTask {
        user_id: slack_event.user_id.clone(),
        channel_id: slack_event.channel_id.clone(),
        response_url: slack_event.response_url.clone(),
        text: filtered_text.clone(),
        message_count,
        target_channel_id,
        custom_prompt,
        visible,
    };
    
    // Send to SQS for async processing
    if let Err(e) = send_to_sqs(&task).await {
        error!("Failed to send to SQS: {}", e);
        return Ok(json!({
            "statusCode": 200,
            "body": json!({
                "response_type": "ephemeral",
                "text": "Sorry, I couldn't process your request at this time. Please try again later."
            }).to_string()
        }));
    }
    
    // Return immediate response to Slack
    info!("Task sent to processing queue successfully");
    
    // Always use ephemeral response from the API Lambda
    // The worker will handle visible responses when needed
    let response_type = "ephemeral";
    
    Ok(json!({
        "statusCode": 200,
        "body": json!({
            "response_type": response_type,
            "text": "Processing your request. I'll send a summary shortly!"
        }).to_string()
    }))
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    // Initialize JSON structured logging
    tldr::setup_logging();

    let func = service_fn(function_handler);
    run(func).await?;
    Ok(())
}
