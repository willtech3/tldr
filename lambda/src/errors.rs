use thiserror::Error;
use slack_morphism::errors::SlackClientError;
use openai_api_rs::v1::error::APIError;

#[derive(Debug, Error)]
pub enum SlackError {
    #[error("Failed to parse Slack event: {0}")]
    ParseError(String),

    #[error("Failed to access Slack API: {0}")]
    ApiError(String),

    #[error("Failed to access OpenAI API: {0}")]
    OpenAIError(String),

    #[error("Failed to send HTTP request: {0}")]
    HttpError(String),

    #[error("Failed to interact with AWS services: {0}")]
    AwsError(String),
}

impl From<SlackClientError> for SlackError {
    fn from(error: SlackClientError) -> Self {
        SlackError::ApiError(error.to_string())
    }
}

impl From<reqwest::Error> for SlackError {
    fn from(error: reqwest::Error) -> Self {
        SlackError::HttpError(error.to_string())
    }
}

impl From<anyhow::Error> for SlackError {
    fn from(error: anyhow::Error) -> Self {
        SlackError::ApiError(error.to_string())
    }
}

// Generic implementation for AWS SDK errors
impl<E> From<aws_sdk_sqs::types::SdkError<E>> for SlackError
where
    E: std::fmt::Display
{
    fn from(error: aws_sdk_sqs::types::SdkError<E>) -> Self {
        SlackError::AwsError(error.to_string())
    }
}

impl From<APIError> for SlackError {
    fn from(error: APIError) -> Self {
        SlackError::OpenAIError(format!("OpenAI API error: {}", error))
    }
}
