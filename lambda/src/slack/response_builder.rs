//! Response-related utilities for Slack interactions
//!
//! This module provides standardized ways to create and format
//! responses sent to Slack, particularly for slash commands.

use serde_json::{Value, json};

/// Create a JSON payload to replace/hide the original slash command
///
/// This function builds a JSON payload that utilizes Slack's `response_url` mechanism
/// to replace the original command with either a specified message or effectively hide it.
///
/// # Arguments
///
/// * `text` - Optional text to show in place of the command. If None or empty, the command will be hidden.
///
/// # Returns
///
/// A JSON Value containing the properly formatted payload for Slack's `response_url`
///
/// # Examples
///
/// ```
/// use tldr::slack::response_builder::create_replace_original_payload;
///
/// // Create a payload that hides the command
/// let hide_payload = create_replace_original_payload(None);
///
/// // Create a payload that replaces the command with text
/// let replace_payload = create_replace_original_payload(Some("Processing your request..."));
/// ```
#[must_use]
pub fn create_replace_original_payload(text: Option<&str>) -> Value {
    // If text is None or empty, we'll just send a blank message (effectively hiding the command)
    if let Some(t) = text.filter(|t| !t.is_empty()) {
        json!({
            "replace_original": true,
            "text": t
        })
    } else {
        json!({
            "replace_original": true,
            "text": " " // Use a single space to effectively hide the message while maintaining its place
        })
    }
}

/// Create a JSON payload for an ephemeral response
///
/// This function builds a JSON payload for sending ephemeral messages through
/// Slack's `response_url` mechanism. Ephemeral messages are only visible to the user
/// who triggered the command.
///
/// # Arguments
///
/// * `text` - The text content to show in the ephemeral message
///
/// # Returns
///
/// A JSON Value containing the properly formatted payload for an ephemeral message
///
/// # Examples
///
/// ```
/// use tldr::slack::response_builder::create_ephemeral_payload;
///
/// // Create a payload for an ephemeral message
/// let payload = create_ephemeral_payload("This message is only visible to you");
/// ```
#[must_use]
pub fn create_ephemeral_payload(text: &str) -> Value {
    json!({
        "text": text,
        "response_type": "ephemeral"
    })
}
