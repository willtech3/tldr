//! All Slack-specific functionality

pub mod bot;
pub mod client;
pub mod message_formatter;
pub mod modal_builder;
pub mod response_builder;

// Re-export main types for convenience
pub use bot::SlackBot;
pub use client::{
    MessageNotInStreamingState, STREAM_MARKDOWN_TEXT_LIMIT, SlackClient, StreamResponse,
    build_append_stream_payload, build_start_stream_payload, build_stop_stream_payload,
};
