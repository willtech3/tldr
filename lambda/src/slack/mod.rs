//! All Slack-specific functionality

pub mod bot;
pub mod canvas_helper;
pub mod client;
pub mod command_parser;
pub mod message_formatter;
pub mod modal_builder;
pub mod response_builder;

// Re-export main types for convenience
pub use bot::SlackBot;
pub use canvas_helper::CanvasHelper;
pub use client::SlackClient;
