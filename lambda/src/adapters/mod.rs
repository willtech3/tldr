/// Adapter layer for interface implementations.
///
/// This module contains adapters that implement domain interfaces:
/// - Web adapters (HTTP handlers, API endpoints)
/// - Messaging adapters (SQS, webhooks)
/// - Persistence adapters (repositories, data access)

pub mod web;
pub mod messaging;
pub mod persistence;