/// TLDR - A Slack chatbot that summarizes unread messages in channels using ChatGPT.
///
/// This crate implements the Worker Lambda for the TLDR Slack bot. The API layer
/// is handled by a separate Bolt TypeScript Lambda (see bolt-ts/).
///
/// # Architecture
///
/// The system uses a two-Lambda design:
/// - **Bolt TypeScript Lambda** (bolt-ts/): Handles Slack events, validates requests, enqueues to SQS
/// - **Rust Worker Lambda** (this crate): Processes SQS messages, fetches channel history,
///   calls OpenAI, and delivers summaries
///
/// Key technologies:
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
///         openai_api_key: "dummy_openai_key".to_string(),
///         openai_org_id: None,
///         openai_model: None,
///         enable_streaming: false,
///         stream_max_chunk_chars: 4000,
///         stream_min_append_interval_ms: 1000,
///     };
///
///     // Initialize the Slack bot
///     let mut bot = SlackBot::new(&config)?;
///
///     // Get and summarize recent messages in a channel
///     let messages = bot.slack_client().get_recent_messages("C12345678", 50).await?;
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
///                 dest_dm: true,
///                 dest_public_post: false,
///             },
///         )
///         .await?;
///
///         match result {
///             SummarizeResult::Summary { text, .. } => println!("Summary: {}", text),
///             SummarizeResult::NoMessages => println!("No messages to summarize"),
///         }
///     }
///
///     Ok(())
/// }
/// ```
// Module declarations
pub mod ai;
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
    let filter_layer = tracing_subscriber::EnvFilter::from_default_env();

    tracing_subscriber::registry()
        .with(fmt_layer)
        .with(filter_layer)
        .init();
}
