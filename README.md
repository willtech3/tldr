# TLDR — Slack AI App Summarizer

TLDR is a serverless Slack bot that turns a wall of unread messages into a concise, AI-generated summary delivered straight to your Slack AI App assistant thread.

---

## ✨ Key Features

- **AI App Experience** – Native Slack AI App split-view integration with suggested prompts, context tracking, and one-tap ⚡ Summarize now buttons.
- **AI-Generated Summaries** – Uses Anthropic Claude Opus 4.8 to distill channel messages into digestible summaries with links, image highlights, and receipts (message permalinks).
- **Custom Styles** – Preset personas (Roast, Receipts, Executive brief, Haiku) or write your own; per-thread or one-off.
- **Summarize Thread Shortcut** – Right-click any message → *Summarize Thread* for a private, in-channel thread recap.
- **Standard Chatbot** – Ask TLDR anything: non-command messages in the assistant pane and `@TLDR` mentions in channels get streamed chat replies (text in, text out — no tools or actions).
- **Engagement Built In** – Post-summary follow-up prompts, thumbs up/down feedback, share-to-channel with confirmation, retry buttons on every failure.
- **Single TypeScript Service** – One Bolt.js Lambda hosts the Slack event surface *and* the streaming summarizer.
- **Streaming Replies** – Summaries stream into the assistant thread token-by-token via Slack's `chat.startStream` / `chat.appendStream` / `chat.stopStream` APIs.

---

## 🚀 Quick Start

### Using TLDR

1. **Open TLDR** – Click the AI Apps icon in the top-right corner of Slack, then select TLDR.
2. **Navigate to a channel** – Switch to any channel in Slack's main view.
3. **Summarize** – Tap *⚡ Summarize now*, click a suggested prompt, or type:
   - `summarize` (or `catch me up`, `what did I miss`, `tldr`) – Summarize the channel you're viewing
   - `summarize last 100` – Summarize last 100 messages
   - `summarize #general` – Summarize a specific channel
   - `style: write as haiku` – Change the summary style for this thread
   - `help` – Show available commands

That's it! TLDR automatically tracks which channel you're viewing and summarizes it.
You can also right-click any message → **Summarize Thread** for a private thread recap,
or `@TLDR <question>` in any channel it's been invited to for a chat reply in that thread.

---

## 🏗️ Architecture

```
┌─────────┐    ┌────────────────────────────────────────┐    ┌──────────────────────┐
│  Slack  │───►│ Single Bolt.js Lambda (TypeScript)     │───►│ Anthropic Messages   │
└─────────┘    │  • Slack signature verification        │    │ API (streaming, SSE) │
               │  • Intent parsing + safety checks      │    └────────┬─────────────┘
               │  • Inline Anthropic streaming summary  │             │
               │  • chat.startStream/appendStream/stop  │◄────────────┘
               └────────────────────────────────────────┘
```

A single Node.js Lambda hosts the entire app. Bolt internally ACKs Slack events;
the handler streams the Anthropic Claude response (Opus 4.8 by default)
straight into the assistant thread via Slack's `chat.*Stream` APIs.

---

## 🔧 Local Development

### Prerequisites

- Node.js 20+ & npm
- Terraform ≥ 1.10
- AWS CLI with a profile that can deploy Lambda + API Gateway
- A Slack workspace (paid plan required for AI Apps) & an Anthropic API key

### Steps

```bash
# 1. Clone
$ git clone https://github.com/your-org/tldr.git && cd tldr

# 2. Configure environment
$ cp terraform/terraform.tfvars.example terraform/terraform.tfvars   # then edit the values

# 3. Install dependencies (Bolt Lambda) and Terraform
$ (cd bolt-ts && npm install)
$ brew install terraform   # or https://developer.hashicorp.com/terraform/install

# 4. Run the full quality gate
$ just qa
```

`just qa` runs: `bolt-build`, `bolt-bundle`, `bolt-lint`, `bolt-test`,
`tf-fmt`, `tf-validate`.

---

## ☁️ Deployment (Terraform)

The **`terraform/`** folder provisions:

- API Gateway endpoint (`/slack/events`, `/slack/interactive`)
- One Node.js Lambda (`tldr-bolt`) — 1 GB memory, 15 min timeout
- IAM role with least-privilege SSM read for the configured parameters
- CloudWatch log group with 1-week retention
- Account-level API Gateway CloudWatch Logs role (for stage access logging)

Deploys normally run in CI (`.github/workflows/deploy.yml`). To deploy locally —
after the one-time S3 state-bucket bootstrap described in
[`terraform/README.md`](terraform/README.md):

```bash
$ (cd bolt-ts && npm run bundle)         # build the Lambda deployment package
$ cd terraform
$ terraform init \
    -backend-config="bucket=<your-tfstate-bucket>" \
    -backend-config="key=tldr/terraform.tfstate" \
    -backend-config="region=us-east-2" \
    -backend-config="use_lockfile=true"
$ terraform apply
$ terraform output -raw api_gateway_url  # paste into the Slack app manifest
```

After the stack is live, update your Slack app manifest with the API Gateway URL.

---

## 🔐 Configuration

Deployment variables:

| Variable | Purpose |
|----------|---------|
| `SLACK_BOT_TOKEN_PARAMETER_NAME` | SSM SecureString parameter for the bot OAuth token |
| `SLACK_SIGNING_SECRET_PARAMETER_NAME` | SSM SecureString parameter for the Slack signing secret |
| `ANTHROPIC_API_KEY_PARAMETER_NAME` | SSM SecureString parameter for the Anthropic API key |
| `ANTHROPIC_MODEL` | Optional override (defaults to `claude-opus-4-8`) |
| `ANTHROPIC_MAX_OUTPUT_TOKENS` | Optional output cap (default 32 000, max 64 000) |
| `ENABLE_STREAMING` | `true` to stream summaries into the thread (recommended, default) |
| `STREAM_MAX_CHUNK_CHARS` | Per-append chunk size for `chat.appendStream` (default 8 000, max 12 000) |
| `STREAM_MIN_APPEND_INTERVAL_MS` | Floor between appends to respect rate limits (default 500 ms) |
| `AWS_ACCOUNT_ID` | Optional. If set, Terraform refuses to apply against any other AWS account |

For local-only runs the Lambda also accepts direct `SLACK_BOT_TOKEN`,
`SLACK_SIGNING_SECRET`, and `ANTHROPIC_API_KEY` env vars.

---

## 🗂️ Project Layout

```
├─ bolt-ts/         # The single Bolt.js Lambda (TypeScript)
│   ├─ src/
│   │   ├─ index.ts          # Lambda entry point
│   │   ├─ app.ts            # Bolt app wiring
│   │   ├─ config.ts         # Env + SSM loader (cached)
│   │   ├─ blocks.ts         # Block Kit builders (welcome, help, style modal)
│   │   ├─ intent.ts         # Natural-language command parser
│   │   ├─ loading_messages.ts
│   │   ├─ security.ts       # Rate limit, membership check, style validation
│   │   ├─ thread_state.ts   # Persists state via Slack message metadata
│   │   ├─ handlers/         # Assistant, style, and action handlers
│   │   ├─ slack/            # Web client wrappers, streaming helpers, sanitiser
│   │   ├─ ai/               # Anthropic Messages client + XML-structured prompt + image helpers
│   │   └─ worker/           # Inline summarisation, chunking, link extraction
│   └─ tests/                # Jest tests for every module above
├─ terraform/       # Infrastructure as code (Terraform)
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

1. Run `just qa` before committing (Bolt build + lint + tests, plus Terraform fmt + validate).
2. Add or update Jest tests for new functionality — TDD is the project default.
3. Open a PR; GitHub Actions runs the same `just qa` gate.

---

## 📄 License

MIT © 2025 TLDR Contributors
