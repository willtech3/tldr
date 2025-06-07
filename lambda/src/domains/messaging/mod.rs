//! Messaging domain for handling Slack message operations.
//!
//! This domain contains:
//! - Message entities and value objects
//! - Channel management logic
//! - Message parsing and formatting
//! - Message retrieval services
///
/// Represents a basic Slack message.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct Message {
    pub channel: String,
    pub user: String,
    pub text: String,
}

impl Message {
    /// Create a new `Message` with the given channel, user and text.
    pub fn new(channel: String, user: String, text: String) -> Self {
        Self { channel, user, text }
    }
}
