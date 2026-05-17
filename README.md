# TLDR — Slack AI App Summarizer

TLDR is a serverless Slack bot that turns a wall of unread messages into a concise, AI-generated summary delivered straight to your Slack AI App assistant thread.

---

## ✨ Key Features

- **AI App Experience** – Native Slack AI App split-view integration with suggested prompts and context tracking.
- **AI-Generated Summaries** – Uses OpenAI (GPT-5.2 by default) to distill channel messages into digestible summaries.
- **Custom Styles** – Make summaries funny, formal, or fit your friend group's vibe.
- **Hybrid Architecture** – TypeScript Bolt.js for Slack events + Rust worker for fast async processing.
- **Built for Speed** – Instant acknowledgement with async summarization for snappy UX.

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
┌─────────┐    ┌────────────────┐   SQS   ┌──────────────┐    ┌────────────────────┐
│  Slack  │───►│ Bolt.js Lambda │──Queue─►│ Rust Worker  │───►│ OpenAI Responses API│
└─────────┘    │  (TypeScript)  │         │   Lambda     │    └────────────────────┘
               └────────────────┘         └──────┬───────┘
                                                 │
                                                 ▼
                                         ┌───────────────┐
                                         │ Assistant     │
                                         │ Thread Reply  │
                                         └───────────────┘
```

1. **Bolt.js Lambda** (`bolt-ts/`) – Handles all Slack events, interactions, home tab, and message parsing. Enqueues summarization jobs to SQS.
2. **Rust Worker Lambda** (`lambda/`) – Fetches channel messages, calls OpenAI, posts summary to the assistant thread.

---

## 🔧 Local Development

### Prerequisites

- Node.js 18+ & npm (for Bolt.js and CDK)
- Rust (stable) with `cargo-lambda` for local Lambda builds
- AWS CLI with a profile that can deploy Lambda + SQS
- A Slack workspace (paid plan required for AI Apps) & OpenAI API key

### Steps

```bash
# 1. Clone
$ git clone https://github.com/your-org/tldr.git && cd tldr

# 2. Configure environment
$ cp cdk/env.example cdk/.env   # then edit the values

# 3. Install Bolt.js dependencies
$ cd bolt-ts && npm install && cd ..

# 4. Build & test the Rust worker
$ cd lambda && cargo test && cd ..

# 5. Run quality checks
$ just qa
```

---

## ☁️ Deployment (AWS CDK)

The **`cdk/`** folder contains an AWS CDK stack that provisions:

- API Gateway endpoint
- Lambda functions (Bolt.js API + Rust Worker)
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

Deployment variables:

| Variable | Purpose |
|----------|---------|
| `SLACK_BOT_TOKEN_PARAMETER_NAME` | SSM SecureString parameter containing the bot OAuth token |
| `SLACK_SIGNING_SECRET_PARAMETER_NAME` | SSM SecureString parameter containing the Slack signing secret |
| `OPENAI_API_KEY_PARAMETER_NAME` | SSM SecureString parameter containing the OpenAI API key |
| `OPENAI_ORG_ID_PARAMETER_NAME` | Optional SSM parameter containing the OpenAI organization ID |
| `OPENAI_MODEL` | Optional, override model (defaults to `gpt-5.2`) |
| `PROCESSING_QUEUE_URL` | URL of the SQS queue |
| `AWS_ACCOUNT_ID` | AWS account ID used by CDK deployment |

For local-only runs, the Lambdas still accept direct `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `OPENAI_API_KEY`, and `OPENAI_ORG_ID` values.

---

## 🗂️ Project Layout

```
├─ bolt-ts/         # TypeScript Bolt.js app (Slack API Lambda)
│   ├─ src/
│   │   ├─ index.ts         # Lambda entrypoint
│   │   ├─ app.ts           # Bolt app configuration
│   │   ├─ handlers/        # Event & action handlers
│   │   ├─ blocks.ts        # Slack Block Kit builders
│   │   └─ intent.ts        # Natural language command parser
│   └─ package.json
├─ lambda/          # Rust crate (Worker Lambda)
│   ├─ src/
│   │   ├─ bin/
│   │   │   └─ worker.rs    # Worker Lambda entrypoint
│   │   ├─ ai/              # OpenAI integration
│   │   ├─ slack/           # Slack API client
│   │   └─ worker/          # Summarization logic
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
- [Enhanced AI Features](docs/enhanced_home_and_prompts.md) – Home tab and prompt improvements

---

## 🤝 Contributing

1. Make sure `cargo check` and `cargo clippy -- -D warnings` pass for Rust.
2. Run `npm run lint` in `bolt-ts/` for TypeScript.
3. Run `just qa` before committing.
4. Add unit tests for new functionality.
5. Open a PR – GitHub Actions will run the full test & lint suite.

---

## 📄 License

MIT © 2025 TLDR Contributors
