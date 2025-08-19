# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TLDR is a serverless Rust-powered Slack bot that generates AI summaries of unread messages. It uses a two-Lambda architecture on AWS with SQS for async processing.

## Key Commands

### Development Commands
```bash
# Local development (from lambda/ directory)
cargo check                    # Quick syntax & type check
cargo test --all-features      # Run all tests
cargo test bot_tests::         # Run specific test module
cargo clippy -- -D warnings    # Run linter with strict warnings
cargo fmt                      # Format code (rustfmt edition 2024)

# Lambda local testing
cargo lambda build --release   # Build Lambda locally
cargo lambda watch            # Dev server on :9000
cargo lambda invoke --data-file test/fixtures/slash_command.json  # Test with fixture
```

### Build & Deploy Commands
```bash
# Build Lambda artifacts for deployment
./build-local.sh              # Standard build
./build-local.sh --debug-logs # Build with debug logging enabled

# CDK deployment (from cdk/ directory)
npm install                   # Install dependencies
npm run build                 # Compile TypeScript
npm run cdk deploy           # Deploy to AWS
npm run cdk diff             # Preview changes
```

## Pre-commit Code Quality Rule

Before committing any changes, always run the consolidated quality checks:

```bash
just qa
```

This runs `cargo fmt --check`, `cargo clippy` with strict warnings, `cargo test`, and builds the CDK TypeScript. Commits should only be made after this succeeds locally.

## Architecture

### Two-Lambda Design
1. **API Lambda** (`src/bin/api.rs`) - Handles Slack slash commands, validates signatures, enqueues to SQS
2. **Worker Lambda** (`src/bin/bootstrap.rs`) - Processes SQS messages, fetches channel history, calls OpenAI, sends DMs

### Core Module Structure
- `bot.rs` - Main SlackBot implementation with retry logic, image handling, OpenAI integration
- `domains/messaging/` - Message handling domain logic
- `slack_parser.rs` - Slash command argument parsing
- `prompt.rs` - OpenAI prompt generation and sanitization
- `response.rs` - Slack response formatting
- `errors.rs` - Custom error types with thiserror
- `formatting.rs` - Message formatting utilities

### Key Design Patterns
- **Static clients** - Uses `once_cell::Lazy` for HTTP/Slack clients
- **Retry logic** - Exponential backoff with jitter for API calls
- **Error handling** - Result<T, SlackError> throughout, no unwrap() in production
- **Feature flags** - Separate `api` and `worker` features for Lambda binaries

## Important Rust Guidelines (from .windsurfrules)

1. **Edition**: Rust 2024, stable toolchain
2. **Safety**: Prefer safe Rust, use `unsafe` only with justification
3. **Error Handling**: Return `Result<T, E>` or `Option<T>`, avoid panics
4. **Style**: snake_case items, PascalCase types, group imports, no glob imports
5. **Testing**: `#[cfg(test)]` modules with tests for public APIs
6. **Linting**: Must pass `cargo clippy --all-targets -- -D warnings -W clippy::pedantic`
7. **Dependencies**: Prefer std-only, use established crates (tokio, serde, reqwest, thiserror)

## Environment Variables

Required for Lambda runtime:
- `SLACK_BOT_TOKEN` - Bot OAuth token (xoxb-...)
- `SLACK_SIGNING_SECRET` - Request verification
- `OPENAI_API_KEY` - ChatGPT access
- `PROCESSING_QUEUE_URL` - SQS queue URL (set by CDK)

## Testing Approach

- Unit tests in `#[cfg(test)]` modules within source files
- Integration tests in `lambda/tests/` directory
- Use `cargo test --test <name>` for specific integration test
- Mock external services, test error paths
- Fixture files in `test/fixtures/` for Lambda invocation testing

## Common Development Tasks

### Adding a New Slash Command Parameter
1. Update `SlackSlashCommandParameters` in `slack_parser.rs`
2. Add parsing logic in `parse_slash_command`
3. Update prompt generation in `prompt.rs` if needed
4. Add tests in `slack_parser_tests.rs`

### Modifying OpenAI Integration
1. Main logic in `bot.rs::generate_summary()`
2. Token limits defined as constants (O3_MAX_CONTEXT_TOKENS, etc.)
3. Image handling in `process_files()` and `maybe_encode_image()`
4. Custom prompts sanitized in `prompt.rs::sanitize_custom_internal()`

### Debugging Lambda Locally
```bash
# Terminal 1: Start local Lambda
cd lambda && cargo lambda watch

# Terminal 2: Send test request
cargo lambda invoke --data-file test/fixtures/slash_command.json
```

## Deployment Notes

- Uses Docker build for Lambda compatibility (Amazon Linux 2)
- Zig cross-compiler for proper GLIBC linking
- CDK creates API Gateway, Lambdas, SQS, IAM roles
- GitHub Actions automates PR checks and main branch deployments
- Artifacts extracted to `lambda/target/lambda/*/function.zip`

## Security Considerations

- Always verify Slack request signatures
- Never log sensitive tokens or API keys
- Mask debug logs in production (use `--debug-logs` flag carefully)
- Parameterize all external inputs
- Follow least-privilege IAM principles
- never write persistent scripts unless specifically directed
- only deploy using ci