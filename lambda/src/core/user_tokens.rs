use aws_sdk_ssm::{Client as SsmClient, config::Region, types::ParameterType};
use serde::{Deserialize, Serialize};

use super::config::AppConfig;
use crate::errors::SlackError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredUserToken {
    pub access_token: String,
    pub scope: Option<String>,
}

fn key_for_user(prefix: &str, slack_user_id: &str) -> String {
    let mut p = prefix.to_string();
    if !p.ends_with('/') {
        p.push('/');
    }
    format!("{p}{slack_user_id}")
}

/// # Errors
///
/// Returns an error if SSM operations fail or JSON serialization fails.
pub async fn put_user_token(
    config: &AppConfig,
    slack_user_id: &str,
    token: &StoredUserToken,
) -> Result<(), SlackError> {
    let shared = aws_config::from_env()
        .region(Region::new("us-east-2"))
        .load()
        .await;
    let client = SsmClient::new(&shared);
    let name = key_for_user(&config.user_token_param_prefix, slack_user_id);
    let value = serde_json::to_string(token)
        .map_err(|e| SlackError::GeneralError(format!("token serialize: {e}")))?;

    client
        .put_parameter()
        .name(name)
        .value(value)
        .r#type(ParameterType::SecureString)
        .overwrite(true)
        .send()
        .await
        .map_err(|e| SlackError::AwsError(format!("ssm put_parameter: {e}")))?;

    Ok(())
}

/// # Errors
///
/// Returns an error if SSM operations fail or JSON parsing fails.
pub async fn get_user_token(
    config: &AppConfig,
    slack_user_id: &str,
) -> Result<Option<StoredUserToken>, SlackError> {
    // Explicitly set region to ensure proper SDK configuration
    let shared = aws_config::from_env()
        .region(Region::new("us-east-2"))
        .load()
        .await;
    let client = SsmClient::new(&shared);
    let name = key_for_user(&config.user_token_param_prefix, slack_user_id);

    tracing::info!("Attempting to get user token for parameter: {}", name);

    match client
        .get_parameter()
        .name(name.clone())
        .with_decryption(true)
        .send()
        .await
    {
        Ok(resp) => {
            let Some(param) = resp.parameter else {
                return Ok(None);
            };
            let Some(value) = param.value() else {
                return Ok(None);
            };
            let token: StoredUserToken = serde_json::from_str(value)
                .map_err(|e| SlackError::GeneralError(format!("token parse: {e}")))?;
            Ok(Some(token))
        }
        Err(e) => {
            // If not found, return Ok(None); otherwise bubble error
            let msg = format!("{e}");
            tracing::warn!("SSM get_parameter error for {}: {}", name, msg);

            // Check for both SDK v2 and v1 error formats
            if msg.contains("ParameterNotFound")
                || msg.contains("Parameter not found")
                || msg.contains("does not exist")
            {
                tracing::info!("Parameter {} not found, returning None", name);
                Ok(None)
            } else {
                tracing::error!("SSM get_parameter failed for {}: {}", name, e);
                Err(SlackError::AwsError(format!("ssm get_parameter: {e}")))
            }
        }
    }
}

/// Mark that we've notified a user to connect OAuth (one-time DM).
/// # Errors
/// Returns error on SSM failures.
pub async fn mark_user_notified(config: &AppConfig, slack_user_id: &str) -> Result<(), SlackError> {
    let shared = aws_config::from_env()
        .region(Region::new("us-east-2"))
        .load()
        .await;
    let client = SsmClient::new(&shared);
    let name = key_for_user(&config.user_token_notify_prefix, slack_user_id);
    client
        .put_parameter()
        .name(name)
        .value("1")
        .r#type(ParameterType::String)
        .overwrite(true)
        .send()
        .await
        .map_err(|e| SlackError::AwsError(format!("ssm mark notify: {e}")))?;
    Ok(())
}

/// Has the user already been notified to connect OAuth?
/// # Errors
/// Returns error on SSM failures.
pub async fn has_user_been_notified(
    config: &AppConfig,
    slack_user_id: &str,
) -> Result<bool, SlackError> {
    let shared = aws_config::from_env()
        .region(Region::new("us-east-2"))
        .load()
        .await;
    let client = SsmClient::new(&shared);
    let name = key_for_user(&config.user_token_notify_prefix, slack_user_id);
    match client.get_parameter().name(name).send().await {
        Ok(_) => Ok(true),
        Err(e) => {
            let msg = format!("{e}");
            if msg.contains("ParameterNotFound") {
                Ok(false)
            } else {
                Err(SlackError::AwsError(format!("ssm has notify: {e}")))
            }
        }
    }
}
