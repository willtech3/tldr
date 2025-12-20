//! All AI/LLM functionality

pub mod client;
pub mod prompt_builder;
pub mod sse;

// Re-export main types for convenience
pub use client::{ActiveStreamingResponse, LlmClient, StreamingResponse, estimate_tokens};
pub use sse::{ParseResult, SseParser, StreamEvent};
