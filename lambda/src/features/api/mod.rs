//! API feature orchestrator: Slack signature verification, routing, and enqueue.

mod parsing;
mod signature;
mod sqs;
mod view_submission;

use crate::core::config::AppConfig;
use crate::core::models::ProcessingTask;
use crate::{Prefill, SlackBot, build_tldr_modal};
use lambda_runtime::{Error, LambdaEvent};
use serde::Serialize;
use serde_json::{Value, json};
use tracing::{error, info};
use uuid::Uuid;

pub use self::function_handler as handler;

/// Lambda handler for the API entrypoint. Verifies Slack signature,
/// routes interactive vs slash-command, and enqueues a `ProcessingTask`.
pub async fn function_handler(
    event: LambdaEvent<serde_json::Value>,
) -> Result<impl Serialize, Error> {
    let config = AppConfig::from_env().map_err(|e| {
        error!("Config error: {}", e);
        Error::from(e)
    })?;
    info!("API Lambda received request: {:?}", event);

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

    // Verify the Slack signature
    let signature = match parsing::get_header_value(headers, "X-Slack-Signature") {
        Some(sig) => sig,
        None => {
            error!("Missing X-Slack-Signature header");
            return Ok(json!({
                "statusCode": 401,
                "body": json!({ "error": "Missing X-Slack-Signature header" }).to_string()
            }));
        }
    };
    let timestamp = match parsing::get_header_value(headers, "X-Slack-Request-Timestamp") {
        Some(ts) => ts,
        None => {
            error!("Missing X-Slack-Request-Timestamp header");
            return Ok(json!({
                "statusCode": 401,
                "body": json!({ "error": "Missing X-Slack-Request-Timestamp header" }).to_string()
            }));
        }
    };
    if !signature::verify_slack_signature(body, timestamp, signature, &config) {
        error!("Slack signature verification failed");
        return Ok(json!({
            "statusCode": 401,
            "body": json!({ "error": "Invalid Slack signature" }).to_string()
        }));
    }

    info!("Slack signature verified successfully");

    // Interactive vs slash
    if parsing::is_interactive_body(body) {
        let payload = match parsing::parse_interactive_payload(body) {
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
            "shortcut" | "message_action" => {
                let mut prefill = Prefill::default();
                if let Some(ch) = parsing::v_str(&payload, &["channel", "id"]) {
                    prefill.initial_conversation = Some(ch.to_string());
                }
                prefill.last_n = Some(100);
                prefill.dest_canvas = true;
                prefill.dest_dm = true;
                prefill.dest_public_post = false;

                let view = build_tldr_modal(&prefill);
                let trigger_id = parsing::v_str(&payload, &["trigger_id"])
                    .unwrap_or("")
                    .to_string();
                let view_clone = view.clone();
                let config_clone = config.clone();
                let modal_handle = tokio::spawn(async move {
                    match SlackBot::new(&config_clone).await {
                        Ok(bot) => {
                            if let Err(e) = bot.open_modal(&trigger_id, &view_clone).await {
                                error!("Failed to open modal: {}", e);
                            }
                        }
                        Err(e) => error!("Failed to initialize SlackBot for views.open: {}", e),
                    }
                });
                let _ = tokio::time::timeout(std::time::Duration::from_millis(2000), modal_handle)
                    .await;
                return Ok(json!({ "statusCode": 200, "body": "{}" }));
            }
            "view_submission" => {
                let correlation_id = Uuid::new_v4().to_string();
                info!(
                    "view_submission received, correlation_id={}",
                    correlation_id
                );
                if let Some(view) = payload.get("view") {
                    match crate::views::validate_view_submission(view) {
                        Ok(()) => {
                            let user_id = parsing::v_str(&payload, &["user", "id"]).unwrap_or("");
                            let task = match view_submission::build_task_from_view(
                                user_id,
                                view,
                                correlation_id.clone(),
                            ) {
                                Ok(t) => t,
                                Err(e) => {
                                    error!(
                                        "Failed to build task (correlation_id={}): {}",
                                        correlation_id, e
                                    );
                                    return Ok(json!({
                                        "statusCode": 200,
                                        "body": json!({
                                            "response_action": "errors",
                                            "errors": { "conv": format!("Error processing request (ref: {}). Please try again.", &correlation_id[..8]) }
                                        }).to_string()
                                    }));
                                }
                            };
                            if let Err(e) = sqs::send_to_sqs(&task, &config).await {
                                error!("Enqueue failed (correlation_id={}): {}", correlation_id, e);
                                return Ok(json!({
                                    "statusCode": 200,
                                    "body": json!({
                                        "response_action": "errors",
                                        "errors": { "conv": format!("Unable to start job (ref: {}). Please try again.", &correlation_id[..8]) }
                                    }).to_string()
                                }));
                            }
                            return Ok(
                                json!({ "statusCode": 200, "body": json!({ "response_action": "clear" }).to_string() }),
                            );
                        }
                        Err(errors) => {
                            return Ok(json!({
                                "statusCode": 200,
                                "body": json!({ "response_action": "errors", "errors": Value::Object(errors) }).to_string()
                            }));
                        }
                    }
                }
                return Ok(
                    json!({ "statusCode": 400, "body": json!({ "error": "Missing view in payload" }).to_string() }),
                );
            }
            _ => {
                info!("Unhandled interactive type: {}", p_type);
                return Ok(json!({ "statusCode": 200, "body": "{}" }));
            }
        }
    }

    // Slash command
    let slack_event = match parsing::parse_slack_event(body) {
        Ok(event) => event,
        Err(e) => {
            error!("Failed to parse Slack event: {}", e);
            return Ok(json!({
                "statusCode": 400,
                "body": json!({ "error": format!("Parse Error: {}", e) }).to_string()
            }));
        }
    };

    let text_parts: Vec<&str> = slack_event.text.split_whitespace().collect();
    let visible = text_parts
        .iter()
        .any(|&p| p == "--visible" || p == "--public");
    let filtered_text: String = text_parts
        .iter()
        .filter(|&&p| p != "--visible" && p != "--public" && p != "--ui" && p != "--modal")
        .cloned()
        .collect::<Vec<&str>>()
        .join(" ");

    let (message_count, target_channel_id, custom_prompt) =
        parsing::parse_kv_params(&filtered_text);

    if text_parts.iter().any(|&p| p == "--ui" || p == "--modal") {
        let prefill = Prefill {
            initial_conversation: Some(slack_event.channel_id.clone()),
            last_n: message_count,
            custom_prompt: custom_prompt.clone(),
            dest_canvas: true,
            dest_dm: true,
            dest_public_post: visible,
        };
        let view = build_tldr_modal(&prefill);
        let trigger_id = slack_event.trigger_id.clone();
        let view_clone = view.clone();
        let config_clone = config.clone();
        let modal_handle = tokio::spawn(async move {
            match SlackBot::new(&config_clone).await {
                Ok(bot) => {
                    let _ = bot.open_modal(&trigger_id, &view_clone).await;
                }
                Err(e) => error!("Failed to initialize SlackBot for views.open: {}", e),
            }
        });
        let _ = tokio::time::timeout(std::time::Duration::from_millis(2000), modal_handle).await;
        return Ok(json!({
            "statusCode": 200,
            "body": json!({ "response_type": "ephemeral", "text": "Opening TLDR configuration…" }).to_string()
        }));
    }

    let correlation_id = Uuid::new_v4().to_string();
    info!(
        "Slash command direct processing, correlation_id={}",
        correlation_id
    );

    let task = ProcessingTask {
        correlation_id: correlation_id.clone(),
        user_id: slack_event.user_id.clone(),
        channel_id: slack_event.channel_id.clone(),
        response_url: Some(slack_event.response_url.clone()),
        text: slack_event.text.clone(),
        message_count,
        target_channel_id: target_channel_id.clone(),
        custom_prompt,
        visible,
        dest_canvas: false,
        dest_dm: !visible && target_channel_id.is_none(),
        dest_public_post: visible || target_channel_id.is_some(),
    };

    if let Err(e) = sqs::send_to_sqs(&task, &config).await {
        error!(
            "Failed to enqueue task (correlation_id={}): {}",
            correlation_id, e
        );
        return Ok(json!({
            "statusCode": 200,
            "body": json!({
                "response_type": "ephemeral",
                "text": format!("Failed to start summarization. Please try again. (ref: {})", &correlation_id[..8])
            }).to_string()
        }));
    }

    Ok(json!({
        "statusCode": 200,
        "body": json!({ "response_type": "ephemeral", "text": "✨ Starting summarization... You'll receive the summary shortly." }).to_string()
    }))
}
