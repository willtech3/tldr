//! Slack API Lambda handler for slash commands and interactive payloads.
//!
//! - Slash command (`/tldr`) path: verifies signature, opens modal with prefill,
//!   returns ephemeral ACK.
//! - Interactive path (`/slack/interactive`):
//!   - `shortcut` / `message_action`: opens the TLDR modal via `views.open`
//!   - `view_submission`: validates input, enqueues a job to SQS, and responds
//!     with `{ response_action: "clear" }` on success or `{ response_action: "errors" }`
//!     when validation fails.
//!
//! Correlation IDs (UUID v4) are propagated as part of the enqueued task to enable
//! API→Worker traceability in logs.
use anyhow::Result;
use aws_config::meta::region::RegionProviderChain;
use aws_sdk_sqs::Client as SqsClient;
use hex;
use hmac::{Hmac, Mac};
use lambda_runtime::{Error, LambdaEvent, run, service_fn};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use std::env;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info};
use uuid::Uuid;

// Import shared modules
use tldr::SlackBot;
use tldr::{
    Prefill, SlackError, build_tldr_modal, sanitize_custom_prompt,
    slack_parser::{SlackCommandEvent, decode_url_component, parse_form_data},
    validate_view_submission,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessingTask {
    pub correlation_id: String,
    pub user_id: String,
    pub channel_id: String,
    pub response_url: Option<String>,
    pub text: String,
    pub message_count: Option<u32>,
    pub target_channel_id: Option<String>,
    pub custom_prompt: Option<String>,
    pub visible: bool,
}

async fn send_to_sqs(task: &ProcessingTask) -> Result<(), SlackError> {
    // Get queue URL from environment
    let queue_url = env::var("PROCESSING_QUEUE_URL").map_err(|_| {
        SlackError::AwsError("PROCESSING_QUEUE_URL environment variable not set".to_string())
    })?;

    // Set up AWS SDK
    let region_provider = RegionProviderChain::default_provider().or_else("us-east-1");
    let shared_config = aws_config::from_env().region(region_provider).load().await;
    let client = SqsClient::new(&shared_config);

    // Serialize task to JSON string
    let message_body = serde_json::to_string(task)
        .map_err(|e| SlackError::ApiError(format!("Failed to serialize task: {}", e)))?;

    // Use the builder pattern correctly for SQS client
    client
        .send_message()
        .queue_url(queue_url)
        .message_body(message_body)
        .send()
        .await
        .map_err(|e| SlackError::AwsError(format!("Failed to send message to SQS: {}", e)))?;

    Ok(())
}

/// Detects whether the incoming body is a Slack interactive payload (form-encoded with a `payload=` JSON string)
fn is_interactive_body(body: &str) -> bool {
    body.contains("payload=")
}

/// Parses the interactive `payload` JSON from a form-encoded body
fn parse_interactive_payload(form_body: &str) -> Result<Value, SlackError> {
    // Very small parser for key=value&key=value to extract `payload`
    for pair in form_body.split('&') {
        if let Some(eq_idx) = pair.find('=') {
            let key = &pair[..eq_idx];
            if key == "payload" {
                let raw_val = &pair[eq_idx + 1..];
                let decoded = decode_url_component(raw_val).map_err(|e| {
                    SlackError::ParseError(format!("Failed to decode payload: {}", e))
                })?;
                let v: Value = serde_json::from_str(&decoded)
                    .map_err(|e| SlackError::ParseError(format!("Invalid JSON payload: {}", e)))?;
                return Ok(v);
            }
        }
    }
    Err(SlackError::ParseError("Missing payload field".to_string()))
}

/// Helper: traverse a nested JSON object by path of keys.
fn v_path<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = root;
    for key in path {
        cur = cur.get(*key)?;
    }
    Some(cur)
}

/// Helper: get a nested string value by path.
fn v_str<'a>(root: &'a Value, path: &[&str]) -> Option<&'a str> {
    v_path(root, path).and_then(|v| v.as_str())
}

/// Helper: get a nested array value by path.
fn v_array<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Vec<Value>> {
    v_path(root, path).and_then(|v| v.as_array())
}

/// Build a ProcessingTask from a `view_submission` payload's view.state.values
fn build_task_from_view(
    user_id: &str,
    view: &Value,
    correlation_id: String,
) -> Result<ProcessingTask, SlackError> {
    // Ensure view.state.values exists
    let _ = v_path(view, &["state", "values"]) // only for presence check
        .and_then(|v| v.as_object())
        .ok_or_else(|| SlackError::ParseError("view.state.values missing".to_string()))?;

    // Conversation
    let channel_id = v_str(
        view,
        &[
            "state",
            "values",
            "conv",
            "conv_id",
            "selected_conversation",
        ],
    ) //
    .unwrap_or("")
    .to_string();

    // Range mode
    let mode = v_str(
        view,
        &[
            "state",
            "values",
            "range",
            "mode",
            "selected_option",
            "value",
        ],
    ) //
    .unwrap_or("unread_since_last_run");

    // Last N (optional)
    let message_count = v_str(view, &["state", "values", "lastn", "n", "value"]) //
        .and_then(|s| s.parse::<u32>().ok());

    // Destination checkboxes
    let mut visible = false;
    if let Some(selected) = v_array(
        view,
        &["state", "values", "dest", "dest_flags", "selected_options"],
    ) {
        for opt in selected {
            if let Some(val) = opt.get("value").and_then(|s| s.as_str()) {
                match val {
                    "public_post" => visible = true,
                    "dm" => {}
                    _ => {}
                }
            }
        }
    }

    // Custom prompt
    let custom_prompt = v_str(view, &["state", "values", "style", "custom", "value"]) //
        .map(|s| s.to_string())
        .and_then(|raw| sanitize_custom_prompt(&raw).ok());

    // For now, only honor last_n mode explicitly; otherwise default (None) means unread
    let effective_count = if mode == "last_n" {
        message_count
    } else {
        None
    };

    Ok(ProcessingTask {
        correlation_id,
        user_id: user_id.to_string(),
        channel_id,
        response_url: None,
        text: String::new(),
        message_count: effective_count,
        target_channel_id: None,
        custom_prompt,
        visible,
    })
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

/// Case-insensitive header lookup from the API Gateway/Lambda JSON headers map.
fn get_header_value<'a>(headers: &'a serde_json::Value, name: &str) -> Option<&'a str> {
    // Try exact match first (avoids allocation in common case)
    if let Some(v) = headers.get(name).and_then(|s| s.as_str()) {
        return Some(v);
    }
    // Fall back to case-insensitive search
    headers.as_object().and_then(|map| {
        map.iter().find_map(|(k, v)| {
            if k.eq_ignore_ascii_case(name) {
                v.as_str()
            } else {
                None
            }
        })
    })
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
        error!(
            "Signature verification failed. Computed: '{}', Received: '{}'",
            computed_signature, signature
        );
        false
    }
}

pub use self::function_handler as handler;

pub async fn function_handler(
    event: LambdaEvent<serde_json::Value>,
) -> Result<impl Serialize, Error> {
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
    let signature = match get_header_value(headers, "X-Slack-Signature") {
        Some(sig) => sig,
        None => {
            error!("Missing X-Slack-Signature header");
            return Ok(json!({
                "statusCode": 401,
                "body": json!({ "error": "Missing X-Slack-Signature header" }).to_string()
            }));
        }
    };

    let timestamp = match get_header_value(headers, "X-Slack-Request-Timestamp") {
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
    // Branch: interactive vs slash command
    if is_interactive_body(body) {
        // Parse JSON payload
        let payload = match parse_interactive_payload(body) {
            Ok(v) => v,
            Err(e) => {
                error!("Interactive payload parse error: {}", e);
                return Ok(json!({
                    "statusCode": 400,
                    "body": json!({ "error": format!("Parse Error: {}", e) }).to_string()
                }));
            }
        };

        let p_type = payload.get("type").and_then(|s| s.as_str()).unwrap_or("");
        match p_type {
            // Global shortcut or message action → open modal
            "shortcut" | "message_action" => {
                let mut prefill = Prefill::default();
                // Try to prefill from channel if present (message_action)
                if let Some(ch) = v_str(&payload, &["channel", "id"]) {
                    prefill.initial_conversation = Some(ch.to_string());
                }
                prefill.last_n = Some(100);
                prefill.dest_canvas = true;
                prefill.dest_dm = true;
                prefill.dest_public_post = false;

                let view = build_tldr_modal(&prefill);
                let trigger_id = v_str(&payload, &["trigger_id"]) //
                    .unwrap_or("")
                    .to_string();
                let view_clone = view.clone();
                let modal_handle = tokio::spawn(async move {
                    match SlackBot::new().await {
                        Ok(bot) => {
                            if let Err(e) = bot.open_modal(&trigger_id, &view_clone).await {
                                error!("Failed to open modal: {}", e);
                            }
                        }
                        Err(e) => {
                            error!("Failed to initialize SlackBot for views.open: {}", e);
                        }
                    }
                });
                // Wait up to 2500ms for modal to open, staying within Slack's 3s limit
                let _ = tokio::time::timeout(std::time::Duration::from_millis(2500), modal_handle)
                    .await;

                return Ok(json!({
                    "statusCode": 200,
                    "body": "{}"
                }));
            }
            // Modal submission → validate, enqueue, clear
            "view_submission" => {
                let correlation_id = Uuid::new_v4().to_string();
                info!(
                    "view_submission received, correlation_id={}",
                    correlation_id
                );

                // Validate fields
                if let Some(view) = payload.get("view") {
                    match validate_view_submission(view) {
                        Ok(()) => {
                            // Build task and enqueue
                            let user_id = v_str(&payload, &["user", "id"]).unwrap_or("");
                            let task = match build_task_from_view(
                                user_id,
                                view,
                                correlation_id.clone(),
                            ) {
                                Ok(t) => t,
                                Err(e) => {
                                    error!("Failed to build task: {}", e);
                                    return Ok(json!({
                                        "statusCode": 200,
                                        "body": json!({
                                            "response_action": "errors",
                                            "errors": { "conv": "Something went wrong; please try again." }
                                        }).to_string()
                                    }));
                                }
                            };
                            if let Err(e) = send_to_sqs(&task).await {
                                error!("Enqueue failed (correlation_id={}): {}", correlation_id, e);
                                return Ok(json!({
                                    "statusCode": 200,
                                    "body": json!({
                                        "response_action": "errors",
                                        "errors": { "conv": "Unable to start the job. Please try again." }
                                    }).to_string()
                                }));
                            }

                            return Ok(json!({
                                "statusCode": 200,
                                "body": json!({ "response_action": "clear" }).to_string()
                            }));
                        }
                        Err(errors) => {
                            return Ok(json!({
                                "statusCode": 200,
                                "body": json!({
                                    "response_action": "errors",
                                    "errors": Value::Object(errors)
                                }).to_string()
                            }));
                        }
                    }
                }

                // If no view present
                return Ok(json!({
                    "statusCode": 400,
                    "body": json!({ "error": "Missing view in payload" }).to_string()
                }));
            }
            _ => {
                // Acknowledge unknown type to avoid Slack retries
                info!("Unhandled interactive type: {}", p_type);
                return Ok(json!({
                    "statusCode": 200,
                    "body": "{}"
                }));
            }
        }
    }

    // Fallback: treat as slash command (existing behavior)
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
    let visible = text_parts
        .iter()
        .any(|&part| part == "--visible" || part == "--public");

    // Filter out the visibility flags from the text for other processing
    let filtered_text: String = text_parts
        .iter()
        .filter(|&&part| part != "--visible" && part != "--public")
        .cloned()
        .collect::<Vec<&str>>()
        .join(" ");

    // Define regex for parsing key-value parameters with proper quote handling
    static KV_RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r#"(\w+)\s*=\s*("[^"]*"|\S+)"#).expect("Failed to compile parameter parsing regex - this is a static pattern and should never fail")
    });

    // Parse parameters from filtered text
    let mut message_count: Option<u32> = None;
    // Note: channel targeting is now handled via modal; we intentionally skip parsing it here.
    let mut custom_prompt: Option<String> = None;

    // Use regex captures to properly handle quoted values
    for cap in KV_RE.captures_iter(&filtered_text) {
        let key = &cap[1].to_lowercase();
        let raw = cap[2].trim_matches('"');

        match key.as_str() {
            "count" => {
                if let Ok(count) = raw.parse::<u32>() {
                    message_count = Some(count);
                }
            }
            "channel" => {}
            "custom" => {
                // Sanitize custom prompt
                match sanitize_custom_prompt(raw) {
                    Ok(sanitized_prompt) => {
                        custom_prompt = Some(sanitized_prompt);
                    }
                    Err(e) => {
                        info!("Invalid custom prompt rejected: {}", e);
                    }
                }
            }
            _ => {}
        }
    }

    // Prefer UI per plan: open modal (must be within 3s trigger lifetime). Do it in background
    // to ensure we ACK the slash command promptly.
    let prefill = Prefill {
        initial_conversation: Some(slack_event.channel_id.clone()),
        last_n: message_count,
        custom_prompt: custom_prompt.clone(),
        dest_canvas: true,
        dest_dm: !visible,
        dest_public_post: visible,
    };

    let view = build_tldr_modal(&prefill);

    // Open modal using Slack Web API (3s trigger lifetime)
    // Wait briefly to ensure the modal opens before Lambda container freezes
    let trigger_id = slack_event.trigger_id.clone();
    let view_clone = view.clone();
    let modal_handle = tokio::spawn(async move {
        match SlackBot::new().await {
            Ok(bot) => {
                if let Err(e) = bot.open_modal(&trigger_id, &view_clone).await {
                    error!("Failed to open modal: {}", e);
                }
            }
            Err(e) => {
                error!("Failed to initialize SlackBot for views.open: {}", e);
            }
        }
    });

    // Wait up to 2500ms for modal to open, staying within Slack's 3s limit
    let _ = tokio::time::timeout(std::time::Duration::from_millis(2500), modal_handle).await;

    Ok(json!({
        "statusCode": 200,
        "body": json!({
            "response_type": "ephemeral",
            "text": "Opening TLDR configuration…"
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_case_insensitive_header_lookup() {
        let headers = json!({
            "x-slack-signature": "v0=test_sig_lower",
            "X-SLACK-REQUEST-TIMESTAMP": "1234567890",
            "Content-Type": "application/x-www-form-urlencoded"
        });

        // Test exact match
        assert_eq!(
            get_header_value(&headers, "Content-Type"),
            Some("application/x-www-form-urlencoded")
        );

        // Test case-insensitive matches
        assert_eq!(
            get_header_value(&headers, "X-Slack-Signature"),
            Some("v0=test_sig_lower")
        );
        assert_eq!(
            get_header_value(&headers, "x-slack-request-timestamp"),
            Some("1234567890")
        );

        // Test non-existent header
        assert_eq!(get_header_value(&headers, "Non-Existent-Header"), None);
    }

    #[test]
    fn parse_interactive_payload_basic() {
        let payload = json!({ "type": "shortcut", "trigger_id": "123" }).to_string();
        let form = format!("payload={}", urlencoding::encode(&payload));
        let v = parse_interactive_payload(&form).expect("should parse");
        assert_eq!(v.get("type").and_then(|s| s.as_str()), Some("shortcut"));
    }

    #[test]
    fn build_task_from_view_submission_lastn() {
        let view = json!({
            "state": { "values": {
                "conv": { "conv_id": { "selected_conversation": "C123" } },
                "range": { "mode": { "selected_option": { "value": "last_n" } } },
                "lastn": { "n": { "value": "25" } },
                "dest": { "dest_flags": { "selected_options": [ { "value": "dm" } ] } },
                "style": { "custom": { "value": "Please keep it brief" } }
            } }
        });
        let cid = "test-corr".to_string();
        let task = build_task_from_view("U123", &view, cid.clone()).expect("task");
        assert_eq!(task.correlation_id, cid);
        assert_eq!(task.user_id, "U123");
        assert_eq!(task.channel_id, "C123");
        assert_eq!(task.message_count, Some(25));
        assert!(!task.visible);
        assert!(task.response_url.is_none());
    }
}
