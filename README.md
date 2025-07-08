# TLDR — Slack ChatGPT Summarizer

> 🚀 Never miss important conversations again! TLDR is a serverless, Rust-powered Slack bot that transforms overwhelming message threads into concise, AI-generated summaries delivered straight to your DM.

---

## ✨ Key Features

- **🎯 Slash Command Workflow** – Trigger summaries with `/tldr` in any channel.
- **🤖 AI-Generated Summaries** – Uses OpenAI ChatGPT to distill unread messages into actionable insights.
- **⚡ Two-Lambda Architecture** – Instant slash-command acknowledgement + async processing for lightning-fast UX.
- **🦀 Built with Safe, Async Rust** – Leverages Tokio runtime, `slack-morphism` and `openai-api-rs` for reliability and performance.

---

## 🏗️ High-Level Architecture

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

## 🚀 Usage

1. **Install the Slack App** in your workspace (see [Slack Setup](#slack-setup) below).
2. In any channel type:

```text
/tldr
```

3. A DM will arrive with a neatly formatted summary of everything you missed. ✨

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

## 🛠️ Slack Setup

### Creating Your Slack App

1. Visit [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch** and provide:
   - App Name: `TLDR Bot`
   - Workspace: Select your development workspace

### Bot Configuration

1. Navigate to **OAuth & Permissions** and add these Bot Token Scopes:
   - `channels:history` - Read channel message history
   - `channels:read` - View basic channel information
   - `chat:write` - Send messages as the bot
   - `commands` - Add slash commands
   - `im:write` - Send direct messages
   - `users:read` - View user information

2. Install the app to your workspace and copy the **Bot User OAuth Token** (starts with `xoxb-`)

3. Under **Slash Commands**, create a new command:
   - Command: `/tldr`
   - Request URL: `https://your-api-gateway-url/slack/commands` (update after deployment)
   - Short Description: `Summarize unread messages`
   - Usage Hint: `[count=N] [channel=#name] [--visible] [custom="..."]`

4. Under **Basic Information**, copy your **Signing Secret**

---

## 🔧 Quick Start for Local Development

### Prerequisites

- **Rust** (stable, Edition 2024) - [Install Rust](https://rustup.rs/)
- **cargo-lambda** ≥ 0.17 - Install with: `cargo install cargo-lambda`
- **AWS CLI** configured with deployment credentials - [AWS CLI Setup](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-configure.html)
- **Node.js 18+** & npm (for CDK infrastructure) - [Install Node.js](https://nodejs.org/)
- **Slack workspace** with admin access
- **OpenAI API key** - [Get API Key](https://platform.openai.com/api-keys)

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/your-org/tldr.git && cd tldr

# 2. Configure environment variables
cp .env.example .env
# Edit .env with your Slack and OpenAI credentials

# 3. Build & test the Lambda functions
cd lambda
cargo test
cargo lambda build --release

# 4. Start local Lambda runtime for testing
cargo lambda watch   # Starts on http://localhost:9000
```

Invoke the API Lambda locally with a sample payload:

```bash
cargo lambda invoke --data-file test/fixtures/slash_command.json
```

---

## ☁️ Deployment (AWS CDK)

The **`infrastructure/`** folder contains an *AWS CDK* stack that provisions:

- API Gateway endpoint
- Two Lambda functions (API + Worker)
- SQS queue
- IAM roles & CloudWatch logs

Deploy in one command:

```bash
cd infrastructure
npm install             # Install CDK dependencies
npm run cdk deploy      # Deploy to AWS
```

After the stack is live, copy the API Gateway URL into your Slack slash-command configuration.

---

## 🔐 Configuration

Environment variables (set in Lambda or an `.env` file for local runs):

| Variable | Purpose | Required |
| `SLACK_BOT_TOKEN` | Bot OAuth token (starts with `xoxb-…`) | ✅ |
| `SLACK_SIGNING_SECRET` | Verifies Slack requests are from Slack | ✅ |
| `OPENAI_API_KEY` | Access token for ChatGPT API | ✅ |
| `PROCESSING_QUEUE_URL` | SQS queue URL (auto-set by CDK) | ✅ |

---

## 🗂️ Project Structure

```
├─ lambda/              # Rust crate with both Lambda handlers
│   ├─ src/
│   │   ├─ api.rs       # API Gateway handler for slash commands
│   │   ├─ worker.rs    # SQS message processor
│   │   └─ bot.rs       # Shared SlackBot implementation
│   └─ Cargo.toml
├─ infrastructure/      # AWS CDK stack (TypeScript)
│   ├─ lib/
│   │   └─ tldr-stack.ts
│   └─ bin/
│       └─ app.ts
├─ tests/               # Integration tests & fixture payloads
│   └─ fixtures/
│       └─ slash_command.json
├─ .env.example         # Environment variable template
└─ README.md            # You are here! 📍
```

---

## 🤝 Contributing

We welcome contributions! Please follow these guidelines:

1. **Fork & Clone** the repository
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Write tests** for your changes
4. **Ensure code quality**:
   ```bash
   cargo check
   cargo clippy -- -D warnings
   cargo test
   cargo fmt
   ```
5. **Commit your changes**: `git commit -m 'Add amazing feature'`
6. **Push to your fork**: `git push origin feature/amazing-feature`
7. **Open a Pull Request** with a clear description of changes

### Development Tips

- Add unit tests in `#[cfg(test)]` modules
- Include doc-tests for public APIs
- Follow Rust naming conventions and idioms
- Keep commits atomic and well-described

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🌟 Acknowledgments

- Built with [slack-morphism](https://github.com/abdolence/slack-morphism-rust) for Slack API interactions
- Powered by [OpenAI's ChatGPT](https://openai.com/) for intelligent summarization
- Infrastructure managed with [AWS CDK](https://aws.amazon.com/cdk/)
- Special thanks to all contributors who help make TLDR better!

---

<p align="center">
  Made with ❤️ and 🦀 by the TLDR Contributors
</p>
