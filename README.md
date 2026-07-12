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

1. **Open TLDR** – Click the AI Apps icon in the top-right corner of Slack, then select TLDR.
2. **Navigate to a channel** – Switch to any channel in Slack's main view.
3. **Summarize** – Tap *⚡ Summarize now* or type `summarize`.

That's it — TLDR tracks which channel you're viewing and summarizes it. The full
tour of every way in is below.

---

## 📖 Usage Guide

TLDR has four front doors. Pick whichever fits the moment:

| Entrypoint | Where | Best for |
|------------|-------|----------|
| [Assistant pane](#-assistant-pane--summaries--chat) | AI Apps sidebar | Summaries, styles, and follow-up chat |
| [Buttons](#-buttons--the-no-typing-path) | Welcome card & under every summary | Zero-typing workflows |
| [Summarize Thread](#-summarize-thread-shortcut) | *⋯ More actions* on any message | A private recap of one thread |
| [`@TLDR` mentions](#-tldr-in-channels) | Any channel the bot is in | Quick questions without leaving the conversation |

### 💬 Assistant pane — summaries & chat

Open TLDR from the AI Apps icon and talk to it in plain English:

```text
summarize                        → the channel you're currently viewing
catch me up                      → same thing ("what did I miss" and "tldr" work too)
summarize last 200               → reach further back
summarize #design                → a specific channel (you must be a member)
summarize #design last 25 with style: executive brief
help                             → the command reference card
```

Every summary streams in live and always ends with four sections: **Summary**,
**Links shared**, **Image highlights**, and **Receipts** — permalinks back to the
messages that matter, so you can jump straight to the source.

Anything that *isn't* a command is just conversation. Ask "explain the RFC
linked above" or "draft a short reply I can post" and TLDR answers in the same
thread, with the recent thread context in mind.

### ⚡ Buttons — the no-typing path

- **⚡ Summarize now** on the welcome card summarizes the channel you're viewing;
  the dropdown beside it sets your default message count (5–500, default 50).
- **🎨 Set style** opens a modal with ready-made personas — 🔥 *Roast*,
  📜 *Receipts*, 💼 *Executive brief*, 🌸 *Haiku* — or space to write your own
  (up to 4,000 characters). Save, then hit *⚡ Try it now*.
- Under every summary: **📤 Share to channel** (asks for confirmation first,
  posts with your name on it), one-tap **🔥 Roast This** / **📜 Pull Receipts**
  re-runs, and *Good summary* / *Off the mark* feedback.
- Every failure comes with a **Retry** button — including *Try last 50* when a
  channel is too large to summarize in one go.

### 🎨 Styles you can type

Prefer the keyboard? Styles are commands too:

```text
style: bullet points only, dry humor    → sticks for this thread
summarize with style: sea shanty        → one-off, doesn't stick
clear style                             → back to default
```

### 🧵 Summarize Thread shortcut

Long thread you don't want to scroll? Hover any message → **⋯ More actions** →
**Summarize Thread**. The recap is ephemeral — only you see it, right there in
the channel. TLDR needs to be in the channel (`/invite @TLDR`) to read the thread.

### 📣 `@TLDR` in channels

Mention the bot anywhere it's been invited and it replies in that message's
thread — a quick, streamed chat answer (kept to ~250 words) without anyone
switching to the assistant pane:

```text
@TLDR what's the difference between our staging and prod deploy steps?
@TLDR settle it: tabs or spaces?
```

Mentions are chat-only — for channel summaries, use the assistant pane, which
keeps them private to you.

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
