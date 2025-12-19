//! Response-related utilities for Slack interactions.
//!
//! This module provides standardized ways to create and format
//! responses sent to Slack.

use serde_json::{Value, json};

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
