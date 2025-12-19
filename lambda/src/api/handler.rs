//! API Lambda handler - thin router that delegates to specialized handlers.
//!
//! This module handles:
//! - Request validation (headers, body, signature)
//! - Event callbacks (delegated to `event_handler` module)
//! - Interactive components (delegated to `interactive_handler` module)

use super::{event_handler, helpers, interactive_handler, parsing, signature};
use crate::core::config::AppConfig;
use lambda_runtime::{Error, LambdaEvent};
use serde::Serialize;
use serde_json::Value;
use tracing::{error, info};

pub use self::function_handler as handler;

/// Lambda handler for the API entrypoint.
///
/// Routes requests to specialized handlers based on path and payload type.
///
/// # Errors
///
/// Returns an error response payload if the request is malformed or fails
/// Slack signature verification; otherwise returns a 200 with a JSON body.
#[tracing::instrument(level = "info", skip(event))]
pub async fn function_handler(
    event: LambdaEvent<serde_json::Value>,
) -> Result<impl Serialize, Error> {
    let config = AppConfig::from_env().map_err(|e| {
        error!("Config error: {}", e);
        Error::from(e)
    })?;
    info!("API Lambda received request: {:?}", event);

    // ========================================================================
    // Extract and validate headers
    // ========================================================================

    let Some(headers) = event.payload.get("headers") else {
        error!("Request missing headers");
        return Ok(helpers::err_response(400, "Missing headers"));
    };

    // ========================================================================
    // Slack-signed routes require a body
    // ========================================================================

    let body = match extract_body(&event.payload) {
        Ok(b) => b,
        Err(response) => return Ok(response),
    };

    // ========================================================================
    // Verify Slack signature
    // ========================================================================

    if let Err(response) = verify_signature(body, headers, &config) {
        return Ok(response);
    }

    info!("Slack signature verified successfully");

    // ========================================================================
    // Route to specialized handlers
    // ========================================================================

    // Try parsing as JSON for Events API
    if let Ok(json_body) = serde_json::from_str::<Value>(body) {
        let body_type = json_body.get("type").and_then(|t| t.as_str()).unwrap_or("");

        if body_type == "url_verification" || body_type == "event_callback" {
            return Ok(event_handler::handle_event_callback(&config, &json_body).await);
        }
    }

    // Interactive components (form-encoded with payload=)
    if parsing::is_interactive_body(body) {
        let payload = match parsing::parse_interactive_payload(body) {
            Ok(v) => v,
            Err(e) => {
                error!("Interactive payload parse error: {}", e);
                return Ok(helpers::err_response(400, &format!("Parse Error: {e}")));
            }
        };

        return Ok(interactive_handler::handle_interactive(&config, &payload).await);
    }

    Ok(helpers::err_response(404, "Not Found"))
}

// ============================================================================
// Request Validation Helpers
// ============================================================================

fn extract_body(payload: &Value) -> Result<&str, Value> {
    let Some(body) = payload.get("body") else {
        error!("Request missing body");
        return Err(helpers::err_response(400, "Missing body"));
    };

    let Some(body_str) = body.as_str() else {
        error!("Request body is not a string");
        return Err(helpers::err_response(400, "Invalid body format"));
    };

    Ok(body_str)
}

fn verify_signature(body: &str, headers: &Value, config: &AppConfig) -> Result<(), Value> {
    let Some(sig) = parsing::get_header_value(headers, "X-Slack-Signature") else {
        error!("Missing X-Slack-Signature header");
        return Err(helpers::err_response(
            401,
            "Missing X-Slack-Signature header",
        ));
    };

    let Some(timestamp) = parsing::get_header_value(headers, "X-Slack-Request-Timestamp") else {
        error!("Missing X-Slack-Request-Timestamp header");
        return Err(helpers::err_response(
            401,
            "Missing X-Slack-Request-Timestamp header",
        ));
    };

    if !signature::verify_slack_signature(body, timestamp, sig, config) {
        error!("Slack signature verification failed");
        return Err(helpers::err_response(401, "Invalid Slack signature"));
    }

    Ok(())
}
