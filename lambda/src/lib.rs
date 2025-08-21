#![allow(clippy::pedantic)]
#![allow(clippy::missing_panics_doc)]
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::too_many_lines)]
#![allow(clippy::non_std_lazy_statics)]
#![allow(clippy::unused_async)]
#![allow(clippy::doc_markdown)]
#![allow(clippy::explicit_iter_loop)]
#![allow(clippy::match_same_arms)]
#![allow(clippy::if_not_else)]
#![allow(clippy::semicolon_if_nothing_returned)]
#![allow(clippy::map_unwrap_or)]
#![allow(clippy::redundant_closure_for_method_calls)]
#![allow(clippy::uninlined_format_args)]
#![allow(clippy::must_use_candidate)]
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
/// use tldr::core::config::AppConfig;
///
/// #[tokio::main]
/// async fn main() -> Result<(), Box<dyn std::error::Error>> {
///     // Set up structured logging
///     tldr::setup_logging();
///
///     // Create a dummy AppConfig for the example
///     let config = AppConfig {
///         processing_queue_url: "dummy_url".to_string(),
///         slack_signing_secret: "dummy_secret".to_string(),
///         slack_bot_token: "dummy_token".to_string(),
///         openai_api_key: "dummy_openai_key".to_string(),
///         openai_org_id: None,
///     };
///
///     // Initialize the Slack bot
///     let mut bot = SlackBot::new(&config).await?;
///
///     // Get and summarize unread messages in a channel
///     let messages = bot.get_unread_messages("C12345678").await?;
///     if !messages.is_empty() {
///         let summary = bot.summarize_messages_with_chatgpt(&config, &messages, "C12345678", None).await?;
///         println!("Summary: {}", summary);
///     }
///
///     Ok(())
/// }
/// // Re-export the module components as a public API
pub mod bot;
pub mod canvas;
pub mod core;
pub mod domains;
pub mod errors;
pub mod formatting;
pub mod prompt;
pub mod response;
pub mod slack_parser;
pub mod utils;
pub mod views;

// Public exports
pub use bot::{SlackBot, estimate_tokens};
pub use canvas::CanvasHelper;
pub use errors::SlackError;
pub use formatting::format_summary_message;
pub use prompt::{sanitize_custom_internal, sanitize_custom_prompt};
pub use response::{create_ephemeral_payload, create_replace_original_payload};
pub use views::{Prefill, build_tldr_modal, validate_view_submission};

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
    let fmt_layer = tracing_subscriber::fmt::layer().json().with_target(true);

    tracing_subscriber::registry().with(fmt_layer).init();
}
