//! Client modules for external API interactions

pub mod llm_client;
pub mod slack_client;

pub use llm_client::LlmClient;
pub use slack_client::SlackClient;
