//! Worker Lambda handler and task processing

pub mod deliver;
pub mod handler;
pub mod streaming;
pub mod summarize;

// Re-export the main handler for convenience
pub use handler::handler;

/// Canonical failure message shown to users when summarization fails.
pub const CANONICAL_FAILURE_MESSAGE: &str =
    "Sorry, I couldn't generate a summary at this time. Please try again later.";
