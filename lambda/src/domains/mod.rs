/// Domain layer for TLDR application following Domain-Driven Design principles.
///
/// This module contains the core business logic organized by domain:
/// - messaging: Handles Slack message operations and channel management
/// - summarization: Core summarization logic and AI integration
/// - user_management: User preferences and access control

pub mod messaging;
pub mod summarization;
pub mod user_management;