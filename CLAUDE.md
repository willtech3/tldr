# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TLDR is a serverless Slack AI App that generates AI summaries of unread messages.
A single TypeScript Bolt.js Lambda handles Slack events *and* runs the
summarization pipeline inline, streaming Anthropic Claude (Sonnet 4.6 by
default) responses into the assistant thread via Slack's `chat.startStream` /
`chat.appendStream` / `chat.stopStream` APIs.

## Key Commands

### Development
```bash
# Full quality check (run before committing)
just qa

# Bolt TypeScript development
just bolt-install  # Install npm dependencies
just bolt-build    # Type-check + emit dist/
just bolt-lint     # Run ESLint
just bolt-test     # Run Jest tests

# CDK
just cdk-build
just cdk-lint
```

### Build & Deploy
```bash
# Build the Lambda bundle
cd bolt-ts && npm run bundle

# Deploy via CDK
cd cdk && npm install && npm run deploy
npm run diff  # preview
```

## Pre-commit Code Quality Rule

Before committing any changes, always run:

```bash
just qa
```

This runs (in order): `bolt-build`, `bolt-bundle`, `bolt-lint`, `bolt-test`,
`cdk-build`, `cdk-lint`. Commits should only be made after this succeeds locally.

## Architecture

### Single-Service Bolt Lambda
`bolt-ts/src/` is the entire production app. Slack events hit the
`AwsLambdaReceiver`, Bolt routes them to the Assistant middleware, and the
`userMessage` handler does the work inline. The previous Bolt-API → SQS → Rust
worker split has been removed.

### bolt-ts/ Layout
- `src/index.ts` — Lambda entry point (`AwsLambdaReceiver` + lazy init).
- `src/app.ts` — Bolt app factory; registers Assistant, style modal, action handlers.
- `src/config.ts` — Env + SSM Parameter Store loader (cached).
- `src/handlers/` — Assistant middleware, style modal, summary action buttons.
- `src/blocks.ts` — Block Kit builders for welcome / help / style modal / confirmations.
- `src/intent.ts` — Natural-language command parser (`help`, `style`, `clear_style`, `summarize`, `unknown`).
- `src/security.ts` — Rate limiting, channel-membership check, style validation.
- `src/thread_state.ts` — Persists thread state via Slack message metadata.
- `src/slack/` — Web client wrappers, `chat.*Stream` helpers, generated-text sanitiser, image fetch.
- `src/ai/` — Anthropic Messages API client (`@anthropic-ai/sdk`), XML-structured prompt builder, image helpers.
- `src/worker/` — Inline summarisation pipeline: chunker, link extractor, prompt builder, deliver buttons, streaming orchestrator, top-level `runSummarization`.
- `tests/` — Jest tests for every module above.

### Key Design Patterns
- **Single Lambda** — One Node.js function hosts both the Slack signal layer and the Anthropic streaming worker.
- **Streaming first** — Set `ENABLE_STREAMING=true` (default) so summaries token-stream into the assistant thread.
- **Lazy init** — Module-level singletons cache config, the Bolt receiver, and the SSM client across warm Lambda invocations.
- **Safety net** — `applySafetyNetSections` guarantees every summary contains *Summary / Links shared / Image highlights / Receipts* even if the model omits them.
- **Error containment** — Streaming failures replace the partial Slack message with a canonical error string via `chat.update` (or delete + repost when update fails).

## Important Guidelines

### TypeScript (bolt-ts/)
1. **Strict mode**: All strict TypeScript options enabled.
2. **ESLint**: Must pass linting; tests have relaxed rules but still run through ESLint.
3. **Testing**: Jest tests in `tests/`; mirror the `src/` directory layout. TDD is the project default.
4. **Types**: Explicit return types, avoid `any`. Prefer `KnownBlock` / `Button` from `@slack/types` for Block Kit.

## Environment Variables

### Single Lambda
- `SLACK_BOT_TOKEN_PARAMETER_NAME` — SSM SecureString for bot OAuth token.
- `SLACK_SIGNING_SECRET_PARAMETER_NAME` — SSM SecureString for request verification.
- `ANTHROPIC_API_KEY_PARAMETER_NAME` — SSM SecureString for Anthropic API access.
- `ANTHROPIC_MODEL` — Optional override (defaults to `claude-sonnet-4-6`).
- `ANTHROPIC_MAX_OUTPUT_TOKENS` — Optional output cap (default 16 000, max 64 000).
- `ENABLE_STREAMING` — `true` / `false` (default `true`).
- `STREAM_MAX_CHUNK_CHARS` — Per-append chunk size (default 8 000, capped at 12 000).
- `STREAM_MIN_APPEND_INTERVAL_MS` — Floor between appends (default 500 ms).

For local-only runs the function still accepts direct `SLACK_BOT_TOKEN`,
`SLACK_SIGNING_SECRET`, and `ANTHROPIC_API_KEY` env vars.

## Testing Approach

- Unit tests in `bolt-ts/tests/` mirror `src/` layout.
- Mock external services via injected `fetch` / Slack `WebClient` shapes.
- Test error paths explicitly — the streaming pipeline must clean up partial Slack messages on failure.

## Common Development Tasks

### Adding a New Event Handler
1. Implement the handler under `bolt-ts/src/handlers/`.
2. Register it in `bolt-ts/src/app.ts`.
3. Add Jest tests under `tests/handlers/`.

### Modifying the LLM integration
1. Main logic lives in `src/ai/anthropic.ts` (Anthropic Messages API + SDK streaming).
2. Prompt content lives in `src/ai/prompt.ts` (XML-structured system + user message).
3. Image MIME / base64 helpers in `src/ai/images.ts`.

## Deployment Notes

- One Lambda (`tldr-bolt`) using Node.js 20 runtime, 1 GB memory, 15 min timeout.
- CDK provisions API Gateway, the Lambda, IAM, and CloudWatch logs.
- GitHub Actions automates PR checks (lint + build + test for `bolt-ts/` and `cdk/`) and main-branch deploys.

## Security Considerations

- Bolt verifies Slack signatures automatically via `AwsLambdaReceiver`.
- Generated text is sanitised with `sanitizeGeneratedSlackMrkdwn` so user/group/broadcast mentions are wrapped in code spans before posting.
- Never log sensitive tokens or API keys.
- Parameterize all external inputs.
- Follow least-privilege IAM principles (SSM access scoped to the three configured parameter ARNs: bot token, signing secret, Anthropic API key).
- Only deploy via CI.

## Documentation Standards

### Checklist Formatting
When working with checklists in project documentation files (markdown), use:
- ✅ — Completed item
- ☐ — Incomplete / pending item

When completing tasks from a checklist, update the checkbox emoji from ☐ to ✅.
