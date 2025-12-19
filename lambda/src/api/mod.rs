//! API Lambda handler and request processing

pub mod event_handler;
pub mod handler;
pub mod helpers;
pub mod interactive_handler;
pub mod parsing;
pub mod signature;
pub mod sqs;
pub mod view_submission;

// Re-export the main handler for convenience
pub use handler::handler;
