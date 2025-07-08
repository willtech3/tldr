# TLDR — Slack ChatGPT Summarizer

TLDR is a serverless, Rust-powered Slack bot that turns a wall of unread messages into a concise, ChatGPT-generated summary delivered straight to your DM.

---

## ✨ Key Features

- **Slash Command Workflow** – Trigger summaries with `/tldr` in any channel.
- **AI-Generated Summaries** – Uses OpenAI ChatGPT to distill unread messages.
- **Two-Lambda Architecture** – Instant slash-command acknowledgement + async processing for snappy UX.
- **Built with Safe, Async Rust** – Tokio runtime, `slack-morphism` and `openai-api-rs`.

---

## 🏗️  High-Level Architecture

```
┌─────────┐    ┌────────────┐   SQS   ┌──────────────┐    ┌─────────────┐
│  Slack  │──►│ API Lambda │─▶Queue▶│ Worker Lambda │───►│ OpenAI Chat │
└─────────┘    └────────────┘         └──────┬───────┘    └─────────────┘
                                             │
                                             ▼
                                        ┌─────────┐
                                        │  User   │
                                        └─────────┘
```

1. **API Lambda** – Verifies Slack signatures and enqueues a summarisation job to SQS.
2. **Worker Lambda** – Fetches unread channel messages, asks ChatGPT to summarise them, and DMs the user.

---

## 🚀  Usage

1. **Install the Slack App** in your workspace (see *Slack Setup* below).
2. In any channel type:

```text
/tldr
```

3. A DM will arrive with a neatly formatted summary of everything you missed. ✨

### Example Output

```
📝 Channel Summary for #engineering (23 unread messages)

**Key Discussion Points:**
• Alice proposed switching to Rust for the new microservice
• Bob shared performance benchmarks showing 3x improvement
• Team agreed to start with a proof-of-concept next sprint

**Action Items:**
✓ Bob to set up initial Rust project structure by Friday
✓ Alice to document the migration plan

**Decisions Made:**
• Approved Rust for new services (not migrating existing ones)
• Weekly knowledge-sharing sessions starting Monday
```

### Advanced Parameters

You can tailor the summary by appending flags / key-value pairs after the command:

| Parameter | Example | Description |
|-----------|---------|-------------|
| `count=<N>` | `/tldr count=50` | Summarise the **last N** messages instead of just unread messages. |
| `channel=<#channel>` | `/tldr channel=#general` | Post the summary to a different channel (defaults to DM). |
| `--visible` / `--public` | `/tldr --visible` | Make the summary visible to everyone in the target channel. |
| `custom="…"` | `/tldr custom="Write at an 8th-grade level"` | Provide a custom prompt (max 800 chars) to influence the writing style. |

Parameters can be combined:

```text
/tldr count=100 channel=#project-updates --visible custom="Use bullet points and include action items"
```

---

## 🔧  Quick Start for Local Development

### Prerequisites

- Rust (stable, Edition 2024)
- `cargo-lambda` ≥ 0.17 for local Lambda builds
- AWS CLI with a profile that can deploy Lambda + SQS
- Node 18+ & npm (only for the CDK infrastructure)
- A Slack workspace & OpenAI API key

### Steps

```bash
# 1. Clone
$ git clone https://github.com/your-org/tldr.git && cd tldr

# 2. Configure environment
$ cp .env.example .env   # then edit the values

# 3. Build & test the Lambda crate
$ cd lambda
$ cargo test
$ cargo lambda build --release

# 4. Spin up a local Lambda for manual testing
$ cargo lambda watch   # default on :9000
```

Invoke the API Lambda locally with a sample payload:

```bash
$ cargo lambda invoke --data-file test/fixtures/slash_command.json
```

---

## ☁️  Deployment (AWS CDK)

The **`cdk/`** folder contains an *AWS CDK* stack that provisions:

- API Gateway endpoint
- Two Lambda functions (API + Worker)
- SQS queue
- IAM roles & CloudWatch logs

Deploy in one command:

```bash
$ cd cdk
$ npm install             # first time only
$ npm run cdk deploy
```

After the stack is live, copy the API Gateway URL into your Slack slash-command configuration.

---

## 🔐  Configuration

Environment variables (set in Lambda or an `.env` file for local runs):

| Variable | Purpose |
|----------|---------|
| `SLACK_BOT_TOKEN` | Bot OAuth token (starts with `xoxb-…`) |
| `SLACK_SIGNING_SECRET` | Verifies Slack requests |
| `OPENAI_API_KEY` | Access token for ChatGPT |
| `PROCESSING_QUEUE_URL` | URL of the SQS queue |

---

## 📱  Slack Setup

1. **Create a new Slack App** at [api.slack.com/apps](https://api.slack.com/apps)
2. **Configure OAuth & Permissions:**
   - Add these Bot Token Scopes:
     - `channels:history` - Read channel messages
     - `channels:read` - View basic channel info
     - `chat:write` - Send DMs to users
     - `commands` - Register slash commands
     - `users:read` - Look up user info
3. **Install the app** to your workspace and copy the Bot User OAuth Token
4. **Create a Slash Command:**
   - Command: `/tldr`
   - Request URL: `<Your API Gateway URL>/slack/commands`
   - Short Description: "Summarize unread channel messages"
   - Usage Hint: "[count=N] [channel=#name] [--visible] [custom='...']"
5. **Configure environment variables** with your tokens and secrets

---

## 🗂️  Project Layout

```
├─ lambda/          # Rust crate with both Lambda handlers
│   ├─ src/
│   │   ├─ bin/     # Lambda entry points
│   │   ├─ bot.rs   # SlackBot implementation (shared)
│   │   └─ domains/ # Domain logic modules
│   └─ Cargo.toml
├─ cdk/             # AWS CDK stack (TypeScript)
├─ tests/           # Integration & fixture payloads
└─ README.md
```

---

## 🚦  Performance & Limits

- **Message Limits:** Processes up to 1000 messages per request (Slack API limit)
- **Summary Length:** ChatGPT summaries are capped at ~500 words
- **Processing Time:** Typically 2-5 seconds depending on message count
- **Rate Limits:** 
  - Slack: 50+ requests/minute per workspace
  - OpenAI: Depends on your API tier
- **Lambda Timeout:** 30 seconds (configurable in CDK)

---

## 🔍  Troubleshooting

### Common Issues

**"This slash command experienced an error"**
- Check Lambda logs in CloudWatch for detailed errors
- Verify all environment variables are set correctly
- Ensure your bot has required permissions in the channel

**Summary never arrives**
- Check if the Worker Lambda is processing SQS messages
- Verify the bot can DM you (some workspaces restrict DMs)
- Look for rate limit errors in logs

**"Not in channel" error**
- The bot must be invited to private channels: `/invite @your-bot-name`
- Public channels should work automatically with proper scopes

**Empty or poor summaries**
- Ensure there are actual messages to summarize
- Check OpenAI API key is valid and has credits
- Try adjusting the custom prompt for better results

### Debug Commands

```bash
# Check Lambda logs
$ aws logs tail /aws/lambda/tldr-api --follow
$ aws logs tail /aws/lambda/tldr-worker --follow

# Monitor SQS queue
$ aws sqs get-queue-attributes --queue-url $QUEUE_URL \
    --attribute-names ApproximateNumberOfMessages
```

---

## 🤝  Contributing

1. Make sure `cargo check` and `cargo clippy -- -D warnings` pass.
2. Add unit tests in `#[cfg(test)]` modules and doc-tests in public APIs.
3. Open a PR – GitHub Actions will run the full test & lint suite.

---

## 📄  License

MIT © 2025 TLDR Contributors
