/// Infrastructure layer for external integrations and technical concerns.
///
/// This module contains:
/// - AWS services integration (SQS, Lambda)
/// - Slack API client implementations
/// - OpenAI API client implementations
/// - Database and storage abstractions
/// - Logging and monitoring utilities

pub mod aws;
pub mod slack;
pub mod openai;
pub mod persistence;