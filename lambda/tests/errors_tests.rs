use std::error::Error;
use tldr::errors::SlackError;

#[test]
fn test_slack_error_implements_error_trait() {
    // Verify SlackError implements the Error trait
    fn assert_error<T: Error>(_: &T) {}

    let error = SlackError::ParseError("test error".to_string());
    assert_error(&error);
}

#[test]
fn test_slack_error_display() {
    // Verify Display implementation works correctly
    let error = SlackError::ApiError("API failed".to_string());
    assert_eq!(format!("{error}"), "Failed to access Slack API: API failed");

    let error = SlackError::OpenAIError("Model unavailable".to_string());
    assert_eq!(
        format!("{error}"),
        "Failed to access OpenAI API: Model unavailable"
    );

    let error = SlackError::HttpError("Connection error".to_string());
    assert_eq!(
        format!("{error}"),
        "Failed to send HTTP request: Connection error"
    );
}

#[test]
fn test_slack_error_from_conversions() {
    // Test conversion from anyhow::Error
    let err = anyhow::anyhow!("test error");
    let slack_err: SlackError = err.into();

    match slack_err {
        SlackError::ApiError(msg) => assert!(msg.contains("test error")),
        _ => panic!("Unexpected error type"),
    }
}
