# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TLDR is a serverless Slack AI App that generates AI summaries of unread messages. It uses a two-Lambda architecture on AWS with SQS for async processing:
- **Bolt TypeScript API Lambda** (`bolt-ts/`) - Handles Slack events and interactions using Bolt.js
- **Rust Worker Lambda** (`lambda/`) - Processes SQS messages, calls OpenAI, delivers summaries

## Key Commands

### Development Commands
```bash
# Full quality check (run before committing)
just qa

# Rust worker development
just check      # Quick syntax & type check
just test       # Run all Rust tests
just clippy     # Run linter with strict warnings
just fmt        # Format Rust code

# Bolt TypeScript development
just bolt-install  # Install npm dependencies
just bolt-build    # Build TypeScript
just bolt-lint     # Run ESLint
just bolt-test     # Run Jest tests
```

### Build & Deploy Commands
```bash
# Build Rust worker Lambda
./build-local.sh              # Standard build
./build-local.sh --debug-logs # Build with debug logging enabled

# Build Bolt TypeScript Lambda
cd bolt-ts && npm run build

# CDK deployment (from cdk/ directory)
npm install                   # Install dependencies
just cdk-build                # Compile TypeScript
npm run deploy               # Deploy to AWS
npm run diff                 # Preview changes
```

## Pre-commit Code Quality Rule

Before committing any changes, always run the consolidated quality checks:

```bash
just qa
```

This runs:
- `cargo fmt --check`, `cargo clippy`, `cargo test` for Rust
- `npm run build`, `npm test` for Bolt TypeScript
- `npm run build` for CDK TypeScript

Commits should only be made after this succeeds locally.

## Architecture

### Two-Lambda Design
1. **Bolt API Lambda** (`bolt-ts/src/`) - TypeScript/Bolt.js
   - Handles Slack AI App events (assistant_thread_started, message.im)
   - Validates Slack signatures via Bolt's AwsLambdaReceiver
   - Enqueues tasks to SQS for async processing
   - Returns fast ACK (< 3 seconds) to Slack

2. **Worker Lambda** (`lambda/src/bin/bootstrap.rs`) - Rust
   - Processes SQS messages
   - Fetches channel history via Slack API
   - Calls OpenAI for summarization
   - Delivers results to assistant threads

### Bolt TypeScript Structure (`bolt-ts/`)
- `src/index.ts` - Lambda entry point with AwsLambdaReceiver
- `src/app.ts` - Bolt app configuration
- `src/handlers/` - Event and interaction handlers
- `src/types.ts` - TypeScript types matching Rust ProcessingTask
- `src/sqs.ts` - SQS client for enqueueing tasks

### Rust Worker Structure (`lambda/src/`)
- `worker/` - SQS handler, summarization, delivery
- `ai/` - OpenAI client and prompt builder
- `slack/` - Slack API client and bot logic
- `core/` - Configuration and shared models

### Key Design Patterns
- **Static clients** - Uses `once_cell::Lazy` for HTTP/Slack clients (Rust)
- **Lazy initialization** - Reuses receiver across Lambda invocations (TypeScript)
- **Fast ACK** - Bolt Lambda enqueues work and returns immediately
- **Retry logic** - Exponential backoff with jitter for API calls
- **Error handling** - Result<T, SlackError> throughout, no unwrap() in production

## Important Guidelines

### Rust (lambda/)
1. **Edition**: Rust 2024, stable toolchain
2. **Safety**: Prefer safe Rust, use `unsafe` only with justification
3. **Error Handling**: Return `Result<T, E>` or `Option<T>`, avoid panics
4. **Style**: snake_case items, PascalCase types, group imports, no glob imports
5. **Testing**: `#[cfg(test)]` modules with tests for public APIs
6. **Linting**: Must pass `cargo clippy --all-targets -- -D warnings -W clippy::pedantic`

### TypeScript (bolt-ts/)
1. **Strict mode**: All strict TypeScript options enabled
2. **ESLint**: Must pass linting with TypeScript rules
3. **Testing**: Jest tests in `tests/` directory
4. **Types**: Explicit return types, avoid `any`

## Environment Variables

### Bolt API Lambda
- `SLACK_BOT_TOKEN` - Bot OAuth token (xoxb-...)
- `SLACK_SIGNING_SECRET` - Request verification
- `PROCESSING_QUEUE_URL` - SQS queue URL (set by CDK)

### Worker Lambda
- All of the above, plus:
- `OPENAI_API_KEY` - ChatGPT access
- `OPENAI_ORG_ID` - Optional organization ID

## Testing Approach

### Rust
- Unit tests in `#[cfg(test)]` modules within source files
- Integration tests in `lambda/tests/` directory
- Mock external services, test error paths

### TypeScript
- Unit tests in `bolt-ts/tests/` directory
- Test intent parsing, config loading, block builders
- Run with `just bolt-test`

## Common Development Tasks

### Adding a New AI App Event Handler
1. Add handler in `bolt-ts/src/handlers/`
2. Register in `bolt-ts/src/app.ts`
3. Update ProcessingTask type if needed
4. Add tests in `bolt-ts/tests/`

### Modifying OpenAI Integration
1. Main logic in `lambda/src/ai/` and `lambda/src/worker/summarize.rs`
2. Token limits defined as constants
3. Prompt builder in `lambda/src/ai/prompt_builder.rs`

## Deployment Notes

- Bolt Lambda uses Node.js 20 runtime
- Rust Worker uses PROVIDED_AL2 runtime with Zig cross-compiler
- CDK creates API Gateway, Lambdas, SQS, IAM roles
- GitHub Actions automates PR checks and main branch deployments

## Security Considerations

- Bolt verifies Slack signatures automatically via AwsLambdaReceiver
- Never log sensitive tokens or API keys
- Mask debug logs in production
- Parameterize all external inputs
- Follow least-privilege IAM principles
- Never write persistent scripts unless specifically directed
- Only deploy using CI
- If working off of a checklist in a markdown file then make sure tasks are checked after they are completed
