# ADR-0002: Maintain Stateless Architecture

## Status
**Accepted**

## Date
2025-12-18

## Context
ADR-0001 identified the lack of a persistence layer (DynamoDB) as a potential issue because user preferences and thread context are lost between sessions. We evaluated adding DynamoDB to store this state versus maintaining the current stateless design.

## Decision
We will **not** add a persistent database (DynamoDB) to the architecture. The application will remain fully stateless with no server-side persistence.

**Note:** The Bolt.js rewrite plan (`ai_app_first_rewrite_bolt_js.md`) explicitly removes the OAuth user-token flow that previously stored tokens in SSM. The target architecture has zero server-side state.

## Rationale
1. **Simplicity:** Avoiding a database reduces infrastructure complexity, cost, and maintenance.
2. **Privacy:** Not storing user data (messages, preferences, or tokens) locally reduces the security surface area and simplifies GDPR/data privacy compliance.
3. **Lambda Optimization:** Stateless functions are easier to scale and have simpler cold-start profiles.
4. **Slack-Native State:** Thread-scoped state (like custom styles) is managed using Slack's message metadata. See [Using message metadata](https://docs.slack.dev/messaging/message-metadata/).

## Consequences
- **User Preferences:** Custom styles persist only for the current assistant thread (stored in Slack message metadata), not across threads or channels.
- **No "Unread" Detection:** Without per-user OAuth tokens, the bot cannot detect which messages are unread for a specific user. Summarization defaults to "last N messages."
- **Development Focus:** Engineering effort focuses on leveraging Slack's interaction payloads and message metadata rather than data modeling and synchronization.
- **Infrastructure:** No AWS resources beyond Lambda + SQS are required.

## References
- [ADR-0001: Initial Architecture Assessment](0001-initial-architecture-assessment.md)
- [Bolt.js Rewrite Plan](../ai_app_first_rewrite_bolt_js.md)
