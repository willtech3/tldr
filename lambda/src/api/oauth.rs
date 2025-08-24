use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::Client as HttpClient;
use serde_json::{Value, json};
use tracing::info;

use crate::core::config::AppConfig;
use crate::core::user_tokens::{StoredUserToken, put_user_token};
use crate::errors::SlackError;

#[must_use]
pub fn build_authorize_url(config: &AppConfig, state: &str) -> String {
    let scopes = [
        "channels:read",
        "channels:history",
        "groups:read",
        "groups:history",
        "im:read",
        "im:history",
        "mpim:read",
        "mpim:history",
    ]
    .join(",");

    let client_id = &config.slack_client_id;
    let redirect_uri =
        utf8_percent_encode(&config.slack_redirect_url, NON_ALPHANUMERIC).to_string();
    format!(
        "https://slack.com/oauth/v2/authorize?client_id={client_id}&user_scope={scopes}&redirect_uri={redirect_uri}&state={state}"
    )
}

/// Exchange the OAuth code for a user token and persist it.
/// # Errors
/// Returns an error if the HTTP call fails or token cannot be persisted.
pub async fn handle_callback(
    config: &AppConfig,
    http: &HttpClient,
    code: &str,
) -> Result<(String, String), SlackError> {
    let payload = [
        ("code", code.to_string()),
        ("client_id", config.slack_client_id.clone()),
        ("client_secret", config.slack_client_secret.clone()),
        ("redirect_uri", config.slack_redirect_url.clone()),
    ];

    let resp = http
        .post("https://slack.com/api/oauth.v2.access")
        .form(&payload)
        .send()
        .await
        .map_err(|e| SlackError::GeneralError(format!("oauth.v2.access request: {e}")))?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| SlackError::GeneralError(format!("oauth.v2.access parse: {e}")))?;

    if !body.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let err = body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Err(SlackError::ApiError(format!("oauth error: {err}")));
    }

    let authed_user = body
        .get("authed_user")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let user_id = authed_user
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| SlackError::ParseError("oauth: missing authed_user.id".to_string()))?;
    let access_token = authed_user
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            SlackError::ParseError("oauth: missing authed_user.access_token".to_string())
        })?;
    let scope = authed_user
        .get("scope")
        .and_then(Value::as_str)
        .map(str::to_string);

    let stored = StoredUserToken {
        access_token: access_token.to_string(),
        scope,
    };
    put_user_token(config, user_id, &stored).await?;
    info!("Stored user token for {}", user_id);
    Ok((user_id.to_string(), access_token.to_string()))
}
