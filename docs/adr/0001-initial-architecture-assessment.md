# ADR-0001: Initial Architecture Assessment and Current State

## Status

**Accepted** — This ADR captures the current state of the system as of December 2025 and serves as a baseline for future architectural decisions.

## Date

2025-12-12

## Context

The TLDR Slack bot has evolved organically over time, accumulating features, partial migrations, and technical debt. This ADR documents the current architectural state, known issues, and broken user experiences to provide a clear baseline for future development.

TLDR is a serverless Slack bot that generates AI-powered summaries of channel messages. It uses:
- **AWS Lambda** for serverless execution
- **SQS** for async job queuing
- **OpenAI Responses API** (GPT-5 default) for summarization
- **Rust** (Edition 2024) as the implementation language

### Why This ADR Exists

1. No single document captures the current architectural state
2. Multiple conflicting migration plans exist in `/docs`
3. Several core features are broken or incomplete
4. Future decisions need a documented baseline

---

## Current Architecture

### High-Level Overview

```
┌─────────────────────┐      ┌─────────────────┐      ┌──────────────────────┐
│  Slack              │      │  API Lambda     │      │  Worker Lambda       │
│  - AI App Split     │─────►│  - Verify sig   │─────►│  - Fetch messages    │
│  - Slash Command    │      │  - Route request│ SQS  │  - Call OpenAI       │
│  - Shortcuts        │      │  - Enqueue job  │      │  - Deliver summary   │
└─────────────────────┘      └─────────────────┘      └──────────────────────┘
```

### Entry Points

| Entry Point | Primary? | Description |
|-------------|----------|-------------|
| AI App Split View | Yes | Click TLDR icon in top-right of Slack |
| `/tldr` Slash Command | Legacy | Type `/tldr` in any channel |
| Global/Message Shortcuts | Secondary | Right-click menu or lightning bolt |
| OAuth Flow | Utility | `/auth/slack/start` for per-user token |

### Module Structure

```
lambda/src/
├── api/                    # API Lambda handlers
│   ├── handler.rs          # Thin router (237 lines)
│   ├── event_handler.rs    # AI App events (478 lines)
│   ├── interactive_handler.rs  # Block actions, modals (429 lines)
│   ├── slash_handler.rs    # Legacy /tldr (98 lines)
│   └── helpers.rs          # Common utilities (152 lines)
├── worker/                 # Worker Lambda
│   ├── handler.rs          # SQS event processing
│   ├── summarize.rs        # Message collection + LLM call
│   └── deliver.rs          # Output routing (Thread/DM/Canvas)
├── slack/                  # Slack client abstractions
│   ├── bot.rs              # SlackBot facade
│   ├── client.rs           # Low-level Slack API
│   └── modal_builder.rs    # Block Kit builders
├── ai/                     # OpenAI integration
│   ├── client.rs           # LlmClient wrapper
│   └── prompt_builder.rs   # Prompt construction
└── core/                   # Shared models
    ├── config.rs           # Environment config
    ├── models.rs           # ProcessingTask, Destination
    └── user_tokens.rs      # SSM-based OAuth token storage
```

---

## Architectural Decisions (Historical)

### AD-1: Rust for Lambda Functions

**Decision**: Use Rust instead of JavaScript/TypeScript for Lambda functions.

**Rationale**: 
- Excellent performance and low cold-start times
- Strong type safety
- Memory efficiency for compute-heavy summarization

**Consequences**:
- ✅ Fast execution, reliable runtime behavior
- ❌ Slack's SDK ecosystem is JavaScript-first; `slack-morphism` has less community support
- ❌ AI App features have rapidly evolving payload shapes that are harder to keep up with in Rust
- ❌ A competing proposal exists to rewrite in Bolt.js (see `ai_app_first_rewrite_bolt_js.md`) — **this is now the accepted direction**

### AD-2: Two-Lambda + SQS Architecture

**Decision**: Split request handling (API Lambda) from processing (Worker Lambda) with SQS queue.

**Rationale**: Slack requires <3 second acknowledgement; summarization can take 10-30 seconds.

**Consequences**:
- ✅ Reliable Slack acks, no timeout issues
- ✅ Natural retry mechanism via SQS dead-letter queue
- ❌ Added latency for users (summary arrives as separate message)
- ❌ No visibility into "in progress" status beyond suggested prompts

### AD-3: Stateless Design (No Database)

**Decision**: No persistent storage; use SSM Parameter Store only for OAuth tokens.

**Rationale**: Simplicity, privacy, lower cost.

**Consequences**:
- ✅ Simple deployment (just Lambda + SQS + SSM)
- ✅ No user data to manage (GDPR-friendly)
- ❌ User preferences don't persist between threads
- ❌ No analytics or usage metrics
- ❌ Inconsistent: OAuth tokens ARE persisted (SSM), breaking the stateless model

### AD-4: Multiple Entry Points with Shared Backend

**Decision**: Support AI App, slash command, AND shortcuts all routing to same Worker.

**Rationale**: Backward compatibility with existing `/tldr` users while adding AI App features.

**Consequences**:
- ✅ Existing users can keep using `/tldr`
- ❌ Code complexity (4 sub-handlers with different concerns)
- ❌ Inconsistent UX between entry points
- ❌ `ProcessingTask` model has overlapping fields (`response_url` is slash-only, `thread_ts` is AI-only)

### AD-5: OpenAI Responses API with GPT-5 Default

**Decision**: Use OpenAI Responses API (not Chat Completions) with GPT-5 as default model.

**Rationale**: Access to newer models, better structured output capabilities.

**Consequences**:
- ✅ Future-proofed for new OpenAI features
- ✅ Model is configurable via `OPENAI_MODEL` env var
- ❌ Less community documentation than Chat Completions

---

## Known Issues and Broken User Experiences

### Critical: Image Handling is Broken (#26)

**Problem**: Slack's `permalink_public` returns an HTML viewer page, not the raw image. The Worker skips images due to MIME type mismatch.

**Impact**: Summaries ignore all visual content, degrading quality for modern image-heavy workspaces.

**Location**: `slack/bot.rs` lines 110-168

**Status**: Unresolved

### Critical: "Unread" Detection Requires OAuth (#45)

**Problem**: Per-user unread detection only works if the user has authorized the app via OAuth. Without OAuth, the system silently falls back to "last 100 messages".

**Impact**: The primary value proposition ("summarize my unread messages") doesn't work for most users.

**Location**: `api/event_handler.rs` lines 239-285

**Status**: Partially implemented; OAuth flow exists but isn't surfaced to users

### Major: User Preferences Don't Persist (#81)

**Problem**: Stateless design means custom prompts and style preferences are lost between threads.

**Impact**: Every new conversation starts from scratch; users must re-enter preferences.

**Status**: Resolved; ADR-0002 confirms stateless architecture. Custom styles persist only within the current assistant thread using Slack message metadata.

### ~~Major: Competing Migration Proposals~~ (Resolved)

**Problem**: Multiple planning documents existed with different visions.

**Resolution**: The Bolt.js rewrite plan (`ai_app_first_rewrite_bolt_js.md`) is now the accepted direction. The Rust-based migration plan has been deleted.

**Status**: Resolved — Bolt.js rewrite is the path forward

### Moderate: ProcessingTask Model Has Legacy Fields

**Problem**: The `ProcessingTask` struct has overlapping destination fields:

```rust
pub destination: Destination,  // New enum: Thread, DM, Channel
// Legacy flags below still apply for compatibility during migration
pub dest_canvas: bool,
pub dest_dm: bool,
pub dest_public_post: bool,
pub visible: bool,
```

**Impact**: Confusing data model; unclear which fields take precedence.

**Location**: `core/models.rs`

### Moderate: Dead Code Paths Exist (#82)

**Problem**: Documentation mentions emoji-reaction and scheduled workflows that should be removed.

**Impact**: Unused code increases maintenance burden and confusion.

**Status**: Removal not started

### Minor: Documentation Out of Sync (#39)

**Problem**: README doesn't document AI App flow; migration docs don't reflect completed work.

**Impact**: New contributors face steep learning curve.

---

## Open Questions Requiring Future ADRs

1. ~~**Bolt.js Rewrite**~~: **Decided** — Yes, rewrite API layer in Bolt.js. See `ai_app_first_rewrite_bolt_js.md`.

2. ~~**Persistence Layer**~~: **Decided** — Keep stateless. See [ADR-0002](0002-maintain-stateless-architecture.md).

3. **Image Handling Strategy**: Should we:
   - Download and rehost to S3?
   - Use `slack_file` Block Kit elements?
   - Accept the limitation and document it?
   - *(Bolt.js rewrite PR 5 addresses this with authenticated download + vision model)*

4. ~~**OAuth Surfacing**~~: **Decided** — Remove OAuth unread flow entirely. "Last N messages" is the only mode.

5. ~~**Entry Point Consolidation**~~: **Decided** — AI App split-view only. Slash commands, shortcuts, and Canvas deleted.

6. **Streaming Output**: Should we implement Slack's `chat.*Stream` for real-time summary streaming? *(Deferred — not in V1 scope)*

---

## Consequences of This ADR

### Positive

- Clear documentation of current state for new team members
- Baseline for measuring future improvements
- Explicit acknowledgment of known issues
- Foundation for future ADRs

### Negative

- None directly; this is a documentation exercise

### Neutral

- Sets expectation that all future architectural decisions will be documented
- May prompt discussion about which open questions to tackle first

---

## References

- [ai_app_first_rewrite_bolt_js.md](../ai_app_first_rewrite_bolt_js.md) - Bolt.js rewrite plan (accepted direction)
- [user_workflows.md](../user_workflows.md) - Target user workflow documentation
- [ADR-0002: Maintain Stateless Architecture](0002-maintain-stateless-architecture.md)
- GitHub Issues: #26, #39, #45, #77, #81, #82




