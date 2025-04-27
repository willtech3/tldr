/// TLDR - A Slack chatbot that summarizes unread messages in channels using ChatGPT.
///
/// This crate implements a two-Lambda architecture for the TLDR Slack bot:
/// 1. An API Lambda that receives and verifies Slack slash commands, then queues tasks
/// 2. A Worker Lambda that processes queued tasks and generates summaries with ChatGPT
///
/// # Architecture
///
/// The system uses:
/// - AWS Lambda for serverless execution
/// - SQS for task queuing between Lambdas
/// - slack-morphism for Slack API interactions
/// - openai-api-rs for ChatGPT integration
/// - Tokio for async runtime
///
/// # Example
///
/// ```no_run
/// use tldr::SlackBot;
///
/// #[tokio::main]
/// async fn main() -> Result<(), Box<dyn std::error::Error>> {
///     // Set up structured logging
///     tldr::setup_logging();
///
///     // Initialize the Slack bot
///     let mut bot = SlackBot::new().await?;
///
///     // Get and summarize unread messages in a channel
///     let messages = bot.get_unread_messages("C12345678").await?;
///     if !messages.is_empty() {
///         let summary = bot.summarize_messages_with_chatgpt(&messages, "C12345678", None).await?;
///         println!("Summary: {}", summary);
///     }
///
///     Ok(())
/// }
/// // Re-export the module components as a public API
pub mod bot;
pub mod errors;
pub mod prompt;
pub mod slack_parser;

// Public exports
pub use bot::{SlackBot, estimate_tokens};
pub use errors::SlackError;
pub use prompt::{sanitize_custom_prompt, sanitize_custom_internal};

/// Configure structured logging with JSON format for AWS Lambda environments.
///
/// This function sets up tracing-subscriber with a JSON formatter suitable for
/// CloudWatch Logs integration. It should be called at the start of each Lambda
/// handler.
///
/// # Example
///
/// ```
/// // Initialize structured logging at the start of your Lambda handler
/// tldr::setup_logging();
/// ```
pub fn setup_logging() {
    use tracing_subscriber::prelude::*;
    let fmt_layer = tracing_subscriber::fmt::layer()
        .json()
        .with_target(true);
    
    tracing_subscriber::registry()
        .with(fmt_layer)
        .init();
}
