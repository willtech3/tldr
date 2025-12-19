# TLDR — Slack AI App Summarizer

TLDR is a serverless Slack bot that turns a wall of unread messages into a concise, AI-generated summary delivered straight to your Slack AI App assistant thread.

---

## ✨ Key Features

- **AI App Experience** – Native Slack AI App split-view integration with suggested prompts and context tracking.
- **AI-Generated Summaries** – Uses OpenAI (GPT-5.2 by default) to distill channel messages into digestible summaries.
- **Custom Styles** – Make summaries funny, formal, or fit your friend group's vibe.
- **Two-Lambda Architecture** – Instant acknowledgement + async processing for snappy UX.
- **Built with Rust** – Fast, reliable worker using Tokio runtime.

---

## 🚀 Quick Start

### Using TLDR

1. **Open TLDR** – Click the AI Apps icon in the top-right corner of Slack, then select TLDR.
2. **Navigate to a channel** – Switch to any channel in Slack's main view.
3. **Summarize** – Click a suggested prompt or type:
   - `summarize` – Summarize last 50 messages
   - `summarize last 100` – Summarize last 100 messages
   - `style: write as haiku` – Change the summary style
   - `help` – Show available commands

That's it! TLDR automatically tracks which channel you're viewing and summarizes it.

---

## 🏗️ High-Level Architecture

```
┌─────────┐    ┌────────────┐   SQS   ┌──────────────┐    ┌────────────────────┐
│  Slack  │──►│ API Lambda │─▶Queue▶│ Worker Lambda │───►│ OpenAI Responses API│
└─────────┘    └────────────┘         └──────┬───────┘    └────────────────────┘
                                             │
                                             ▼
                                     ┌───────────────┐
                                     │ Assistant     │
                                     │ Thread Reply  │
                                     └───────────────┘
```

1. **API Lambda** – Handles Slack events and interactions, enqueues jobs to SQS.
2. **Worker Lambda** – Fetches channel messages, calls OpenAI, posts summary to the assistant thread.

---

## 🔧 Local Development

### Prerequisites

- Rust (stable, Edition 2024)
- `cargo-lambda` ≥ 0.17 for local Lambda builds
- AWS CLI with a profile that can deploy Lambda + SQS
- Node 18+ & npm (for the CDK stack)
- A Slack workspace (paid plan required for AI Apps) & OpenAI API key

### Steps

```bash
# 1. Clone
$ git clone https://github.com/your-org/tldr.git && cd tldr

# 2. Configure environment
$ cp cdk/env.example cdk/.env   # then edit the values

# 3. Build & test the Lambda crate
$ cd lambda
$ cargo test
$ cargo lambda build --release

# 4. Run quality checks
$ just qa
```

---

## ☁️ Deployment (AWS CDK)

The **`cdk/`** folder contains an AWS CDK stack that provisions:

- API Gateway endpoint
- Lambda functions (API + Worker)
- SQS queue
- IAM roles & CloudWatch logs

Deploy in one command:

```bash
$ cd cdk
$ npm install             # first time only
$ npm run deploy
```

After the stack is live, update your Slack app manifest with the API Gateway URL.

---

## 🔐 Configuration

Environment variables (set in Lambda or GitHub secrets):

| Variable | Purpose |
|----------|---------|
| `SLACK_BOT_TOKEN` | Bot OAuth token (starts with `xoxb-…`) |
| `SLACK_SIGNING_SECRET` | Verifies Slack requests |
| `OPENAI_API_KEY` | Access token for the OpenAI API |
| `OPENAI_ORG_ID` | Optional, sets OpenAI-Organization header |
| `OPENAI_MODEL` | Optional, override model (defaults to `gpt-5.2`) |
| `PROCESSING_QUEUE_URL` | URL of the SQS queue |

---

## 🗂️ Project Layout

```
├─ lambda/          # Rust crate with Lambda handlers
│   ├─ src/
│   │   ├─ bin/
│   │   │   ├─ api.rs        # API Lambda entrypoint
│   │   │   └─ worker.rs     # Worker Lambda entrypoint
│   │   ├─ ai/               # OpenAI integration
│   │   ├─ api/              # Slack event handlers
│   │   ├─ slack/            # Slack API client
│   │   └─ worker/           # Summarization logic
│   └─ Cargo.toml
├─ cdk/             # AWS CDK stack (TypeScript)
├─ docs/            # Additional documentation
└─ README.md
```

---

## 📚 Documentation

- [Slack Configuration](docs/slack_configuration.md) – Complete Slack app setup guide
- [User Workflows](docs/user_workflows.md) – Detailed user interaction documentation
- [Build & Deployment](docs/build_and_deployment.md) – CI/CD and deployment details
- [AI App Rewrite Plan](docs/ai_app_first_rewrite_bolt_js.md) – Future architecture direction

---

## 🤝 Contributing

1. Make sure `cargo check` and `cargo clippy -- -D warnings` pass.
2. Run `just qa` before committing.
3. Add unit tests in `#[cfg(test)]` modules and doc-tests in public APIs.
4. Open a PR – GitHub Actions will run the full test & lint suite.

---

## 📄 License

MIT © 2025 TLDR Contributors
