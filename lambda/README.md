# Slack Message Summarizer Lambda Function

This is the Rust implementation of the AWS Lambda function that powers the Slack Message Summarizer bot.

## Prerequisites

- Rust toolchain (latest stable)
- `cargo-lambda` for local testing
- AWS CLI configured for deployment

## Development

### Building

```bash
# Standard build
cargo build --release

# Build for AWS Lambda (Linux)
cargo lambda build --release
```

### Testing Locally

```bash
# Run local tests
cargo test

# Start local Lambda server for testing
cargo lambda watch

# In another terminal, invoke the function with test data
cargo lambda invoke --data-file test_data/sample_request.json
```

### Deployment

The Lambda function is automatically deployed via GitHub Actions. See the workflow in `.github/workflows/deploy.yml`.

For manual deployment:

```bash
cargo lambda deploy
```

## Architecture

The Lambda functions use a two-Lambda architecture:

**API Lambda** (`tldr-api`):
1. Receives events from Slack AI App (via API Gateway)
2. Authenticates and verifies requests using Slack signing secrets
3. Enqueues summarization tasks to SQS
4. Returns immediate acknowledgement to Slack

**Worker Lambda** (`tldr-worker`):
1. Processes SQS messages asynchronously
2. Fetches recent messages from specified channels
3. Generates AI summaries using OpenAI
4. Posts summaries to the assistant thread

## Configuration

The following environment variables are required:
- `SLACK_BOT_TOKEN`: OAuth token for the Slack bot
- `SLACK_SIGNING_SECRET`: Used to verify requests from Slack
- `OPENAI_API_KEY`: API key for OpenAI services
