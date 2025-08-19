# Slack Message Summarizer Lambda Functions

This crate contains the Rust Lambda binaries that power the TLDR Slack bot. It
provides two handlers:

* **API Lambda** – verifies slash commands or interactive requests and enqueues
  jobs to SQS.
* **Worker Lambda** – consumes SQS tasks, summarises messages with OpenAI and
  delivers the result back to Slack.

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

# Start local API Lambda server for testing
cargo lambda watch --bin api

# In another terminal, invoke the function with test data
cargo lambda invoke --data-file path/to/slack_event.json --bin api
```

### Deployment

The functions are automatically deployed via GitHub Actions. See the workflow in
`.github/workflows/deploy.yml`.

For manual deployment of both binaries:

```bash
cargo lambda deploy --bin api
cargo lambda deploy --bin worker
```

## Architecture

1. **API Lambda** receives events from Slack (via API Gateway), verifies the
   request and pushes a task to SQS.
2. **Worker Lambda** pulls tasks from SQS, fetches unread messages, generates a
   summary with OpenAI's GPT‑5 model and posts the result back to Slack.

## Configuration

The following environment variables are required:
- `SLACK_BOT_TOKEN`: OAuth token for the Slack bot
- `SLACK_SIGNING_SECRET`: Used to verify requests from Slack
- `OPENAI_API_KEY`: API key for OpenAI services
- `PROCESSING_QUEUE_URL`: SQS queue URL used between the Lambdas
