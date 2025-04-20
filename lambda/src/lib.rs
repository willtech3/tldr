use thiserror::Error;

pub mod slack_parser;

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

impl From<slack_morphism::errors::SlackClientError> for SlackError {
    fn from(error: slack_morphism::errors::SlackClientError) -> Self {
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
