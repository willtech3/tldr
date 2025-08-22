//! All AI/LLM functionality

pub mod client;
pub mod prompt_builder;

// Re-export main types for convenience
pub use client::{LlmClient, estimate_tokens};
