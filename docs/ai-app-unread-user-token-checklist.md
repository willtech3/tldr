## TLDR AI App: Per-user "Last N Unread" + Assistant Thread UX

A modular migration plan to make the AI App split view truly usable for summarization while keeping modules small (≤ ~400 lines) and code cohesive.

### Principles
- Keep modules ≤ ~400 lines; split when they grow.
- Preserve two-Lambda architecture and Responses API usage.
- Prefer UI-native Slack surfaces (assistant thread, suggested prompts, `conversations_select`).
- Safe Rust, no `unwrap()` in new code paths; bubble errors.

### Checklist

- [x] Manifest updates
  - [x] Add user OAuth scopes under `oauth_config.user`:
    - channels:read, channels:history
    - groups:read, groups:history
    - im:read, im:history
    - mpim:read, mpim:history
  - [x] Verify existing bot scopes and events (`assistant_thread_started`, `message.im`) remain

- [ ] OAuth user-token flow (API Lambda)
  - [x] `GET /auth/slack/start` → redirect with user scopes
  - [x] `GET /auth/slack/callback` → exchange code, store user token (SSM Parameter Store or DynamoDB + KMS)
  - [ ] Optional: `GET /auth/slack/disconnect` to revoke and delete token

- [x] Models (lambda/src/core/models.rs)
  - [x] Add `thread_ts: Option<String>`
  - [x] Add `destination: enum { Thread, DM, Channel }` (default Thread)

- [ ] Slack client (lambda/src/slack/client.rs)
  - [x] Convenience `post_message_in_thread(channel_id, thread_ts, text)`
  - [x] Session builder that can operate with a user token for read operations

- [ ] API handler (lambda/src/api/handler.rs)
  - [x] Expand `message.im` parsing to accept: "summarize unread", "summarize last N", `dm me`, `to canvas`, `post here`, and `<#channel>` mention (style parsing pending)
  - [x] If channel missing, post quick-pick message with `conversations_select` and run on selection
  - [x] For unread mode without user token: fallback to last-N, post one-time DM with `/auth/slack/start`
  - [x] Set assistant thread status while processing; clear on completion (handled implicitly by posting result; explicit clear TBD)

- [ ] Modal (lambda/src/slack/modal_builder.rs)
  - [x] Replace range with **"All unread (user-specific)"** default; keep "Last N messages" and "Date range"
  - [x] Default conversation from AI thread context when available

- [ ] Worker (lambda/src/worker/*)
  - [x] All unread (user-specific) when user token present; fallback to last 100 when absent
  - [x] Delivery: if `destination == Thread` and `thread_ts` present, post reply in assistant thread; otherwise DM/Canvas/channel as requested

- [ ] Storage (minimal)
  - [x] Add SSM Parameter Store path `/tldr/user_tokens/{SLACK_USER_ID}` (KMS-encrypted)
  - [x] IAM permissions via CDK

- [ ] QA & Docs
  - [ ] Unit tests for parsing and unread selection fallback
  - [ ] Update README usage and Slack setup docs
  - [ ] Phase 6 QA issue checklist

### Notes
- Default to "All unread (user-specific)" when available; otherwise support "Last N messages".
- Suggested prompts on `assistant_thread_started`: "Summarize unread", "Summarize last 50", "Customize".
- Keep raw HTTP for AI assistant endpoints; use `slack-morphism` sessions for conversations.* methods.
