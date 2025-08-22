//! API Lambda handler and request processing

pub mod handler;
pub mod parsing;
pub mod signature;
pub mod sqs;
pub mod view_submission;

// Re-export the main handler for convenience
pub use handler::handler;