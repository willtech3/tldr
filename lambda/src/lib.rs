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
/// use tldr::slack::SlackBot;
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
///         slack_client_id: "dummy_client_id".to_string(),
///         slack_client_secret: "dummy_client_secret".to_string(),
///         slack_redirect_url: Some("https://example.com/auth/slack/callback".to_string()),
///         user_token_param_prefix: "/tldr/user_tokens/".to_string(),
///         user_token_notify_prefix: "/tldr/user_token_notified/".to_string(),
///         openai_api_key: "dummy_openai_key".to_string(),
///         openai_org_id: None,
///         openai_model: None,
///     };
///
///     // Initialize the Slack bot
///     let mut bot = SlackBot::new(&config)?;
///
///     // Get and summarize unread messages in a channel
///     let messages = bot.slack_client().get_unread_messages("C12345678").await?;
///     if !messages.is_empty() {
///         use tldr::worker::summarize::SummarizeResult;
///         let result = tldr::worker::summarize::summarize_task(
///             &mut bot,
///             &config,
///             &tldr::core::models::ProcessingTask {
///                 correlation_id: "demo".into(),
///                 user_id: "U123".into(),
///                 channel_id: "C12345678".into(),
///                 thread_ts: None,
///                 origin_channel_id: None,
///                 response_url: None,
///                 text: String::new(),
///                 message_count: None,
///                 target_channel_id: None,
///                 custom_prompt: None,
///                 visible: false,
///                 destination: tldr::core::models::Destination::DM,
///                 dest_canvas: false,
///                 dest_dm: true,
///                 dest_public_post: false,
///             },
///         )
///         .await?;
///         
///         match result {
///             SummarizeResult::Summary(summary) => println!("Summary: {}", summary),
///             SummarizeResult::NoMessages => println!("No messages to summarize"),
///             SummarizeResult::OAuthInitiated => println!("OAuth flow initiated"),
///         }
///     }
///
///     Ok(())
/// }
/// ```
// Module declarations
pub mod ai;
pub mod api;
pub mod core;
pub mod errors;
pub mod slack;
pub mod utils;
pub mod worker;

/// Configure structured logging with JSON format for AWS Lambda environments.
///
/// This function sets up tracing-subscriber with a JSON formatter suitable for
/// `CloudWatch` Logs integration. It should be called at the start of each Lambda
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
