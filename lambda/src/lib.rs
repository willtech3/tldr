// Re-export the module components as a public API
pub mod bot;
pub mod errors;
pub mod prompt;
pub mod slack_parser;

// Public exports
pub use bot::{SlackBot, estimate_tokens};
pub use errors::SlackError;
pub use prompt::{sanitize_custom_prompt, sanitize_custom_internal};

// Configure structured logging with JSON format
pub fn setup_logging() {
    use tracing_subscriber::prelude::*;
    let fmt_layer = tracing_subscriber::fmt::layer()
        .json()
        .with_target(true);
    
    tracing_subscriber::registry()
        .with(fmt_layer)
        .init();
}
