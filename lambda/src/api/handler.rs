//! API Lambda handler - thin router that delegates to specialized handlers.
//!
//! This module handles:
//! - Request validation (headers, body, signature)
//! - OAuth routes (delegated to `oauth` module)
//! - Event callbacks (delegated to `event_handler` module)
//! - Interactive components (delegated to `interactive_handler` module)
//! - Slash commands (delegated to `slash_handler` module)

use super::{
    event_handler, helpers, interactive_handler, oauth, parsing, signature, slash_handler,
};
use crate::core::config::AppConfig;
use lambda_runtime::{Error, LambdaEvent};
use serde::Serialize;
use serde_json::Value;
use tracing::{error, info};
use uuid::Uuid;

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
    // OAuth routes (not signed by Slack)
    // ========================================================================

    let path_opt = event
        .payload
        .get("rawPath")
        .and_then(|v| v.as_str())
        .or_else(|| event.payload.get("path").and_then(|v| v.as_str()));

    if let Some(path) = path_opt {
        info!(raw_path = %path, "Request path");

        if path.ends_with("/auth/slack/start") {
            return Ok(handle_oauth_start(&config));
        }

        if path.ends_with("/auth/slack/callback") {
            return handle_oauth_callback(&config, &event.payload, headers).await;
        }
    }

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

    // Slash command (form-encoded)
    match slash_handler::handle_slash_command(&config, body).await {
        Ok(response) => Ok(response),
        Err(e) => {
            error!("Failed to parse Slack event: {}", e);
            Ok(helpers::err_response(400, &format!("Parse Error: {e}")))
        }
    }
}

// ============================================================================
// OAuth Handlers
// ============================================================================

fn handle_oauth_start(config: &AppConfig) -> Value {
    if config.slack_redirect_url.is_none() {
        error!("OAuth failed: SLACK_REDIRECT_URL environment variable is not configured");
        return helpers::err_response(
            500,
            "OAuth configuration error: SLACK_REDIRECT_URL is not set. Please contact your administrator.",
        );
    }

    let state = Uuid::new_v4().to_string();
    let url = oauth::build_authorize_url(config, &state, None);

    helpers::redirect(&url)
}

async fn handle_oauth_callback(
    config: &AppConfig,
    payload: &Value,
    headers: &Value,
) -> Result<Value, Error> {
    // Parse query string for `code`
    let code_opt = payload
        .get("rawQueryString")
        .and_then(|q| q.as_str())
        .and_then(|q| {
            q.split('&')
                .find(|kv| kv.starts_with("code="))
                .map(|kv| kv.trim_start_matches("code=").to_string())
        })
        .or_else(|| {
            payload
                .get("queryStringParameters")
                .and_then(|m| m.get("code"))
                .and_then(|v| v.as_str())
                .map(std::string::ToString::to_string)
        });

    let Some(code) = code_opt else {
        return Ok(helpers::err_response(400, "missing code"));
    };

    if config.slack_redirect_url.is_none() {
        error!("OAuth callback failed: SLACK_REDIRECT_URL environment variable is not configured");
        return Ok(helpers::err_response(
            500,
            "OAuth configuration error: SLACK_REDIRECT_URL is not set. Please contact your administrator.",
        ));
    }

    let http = reqwest::Client::new();
    let xray = parsing::get_header_value(headers, "X-Amzn-Trace-Id").unwrap_or("");

    if let Some(redirect_url) = &config.slack_redirect_url {
        info!(redirect_url=%redirect_url, xray_trace_id=%xray, "Handling OAuth callback");
    }

    match oauth::handle_callback(config, &http, &code, None).await {
        Ok((user_id, _)) => Ok(serde_json::json!({
            "statusCode": 200,
            "body": serde_json::json!({"ok": true, "user_id": user_id}).to_string()
        })),
        Err(e) => {
            error!("OAuth callback failed: {}", e);
            Ok(helpers::err_response(400, &format!("{e}")))
        }
    }
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
