# TLDR: Slack Message Summarizer

A Rust-based Slack bot that summarizes unread messages in channels using OpenAI's ChatGPT, packaged as serverless AWS Lambda functions.

## Project Overview

TLDR is a Slack integration that helps users catch up on conversations they've missed. Using the `/tldr` slash command, users receive AI-generated summaries of unread messages delivered via direct message.

### Core Features

- **Unread Message Summarization**: Get concise summaries of all unread messages in a channel
- **Asynchronous Processing**: Two-part Lambda architecture (API + Worker) ensures responsive user experience
- **Message Filtering**: Intelligent filtering to exclude system messages and focus on meaningful content
- **Secure Request Verification**: HMAC-SHA256 signature verification to ensure authentic Slack requests
- **Resilient Error Handling**: Comprehensive error management for all external API interactions

## Architecture

The application follows a serverless, event-driven architecture:

┌─────────┐    ┌────────────┐    ┌──────────┐    ┌───────────────┐
│  Slack  │───►│ API Lambda │───►│ AWS SQS  │───►│ Worker Lambda │
└─────────┘    └────────────┘    └──────────┘    └───────┬───────┘
                                                         │
                                                         ▼
┌─────────┐                                       ┌─────────────┐
│  User   │◄────────────────────────────────────◄│ OpenAI API  │
└─────────┘                                       └─────────────┘

### System Components

1. **API Lambda (`api.rs`)**
   - Receives and validates Slack slash commands
   - Implements Slack signature verification
   - Queues summarization tasks to SQS
   - Provides immediate acknowledgment to users

2. **Worker Lambda (`worker.rs`)**
   - Processes queued summarization requests
   - Retrieves unread messages from channels
   - Generates summaries using OpenAI's ChatGPT
   - Delivers summaries through Slack DMs

3. **Shared Library (`lib.rs`)**
   - Implements `SlackBot` for Slack API interactions
   - Handles ChatGPT integration
   - Provides error handling and type definitions

4. **AWS Infrastructure**
   - AWS Lambda for compute
   - SQS for message queuing and decoupling
   - API Gateway for webhook endpoints
   - CloudWatch for logging and monitoring

## Technical Implementation

### Rust Implementation Details

- **Async Runtime**: Uses Tokio for asynchronous processing
- **API Clients**: 
  - `slack-morphism` for Slack API interactions
  - `openai-api-rs` for ChatGPT access
- **Error Handling**: Custom `SlackError` enum with conversions from external error types
- **HTTP Client**: Reqwest for webhook responses
- **JSON Handling**: Serde for serialization/deserialization

### Slack Integration

The bot processes slash commands through these steps:
1. **Authentication**: Verifies Slack's request signature
2. **Task Queueing**: Sends task to SQS for asynchronous processing
3. **Message Retrieval**: Fetches unread messages since last read timestamp
4. **Summarization**: Formats messages and sends to ChatGPT
5. **Delivery**: Sends summary via direct message to the requesting user

### Security Considerations

- **Request Verification**: Implements Slack's signing secret verification
- **Timestamp Validation**: Prevents replay attacks by checking request freshness
- **Error Logging**: Detailed error logs without sensitive information
- **Environment Variables**: Secure storage of API tokens and secrets

## Development Setup

### Prerequisites

- **Rust** (latest stable)
  - cargo
  - cargo-lambda for Lambda development
- **Node.js** (v18+) and npm for CDK
- **AWS CLI** configured with appropriate permissions
- **Slack Workspace** with admin privileges
- **OpenAI API** key

### Local Development

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/tldr.git
   cd tldr
   ```

2. **Set up environment variables**
   Create a `.env` file with:
   ```
   SLACK_BOT_TOKEN=xoxb-your-token
   SLACK_SIGNING_SECRET=your-signing-secret
   OPENAI_API_KEY=your-openai-key
   PROCESSING_QUEUE_URL=your-sqs-queue-url
   ```

3. **Build the Lambda functions**
   ```bash
   cd lambda
   cargo build
   # For Lambda deployment
   cargo lambda build --release
   ```

4. **Install CDK dependencies**
   ```bash
   cd ../infrastructure
   npm install
   ```

5. **Run tests**
   ```bash
   cd ../lambda
   cargo test
   ```

### Local Testing

1. **Start Lambda locally**
   ```bash
   cargo lambda watch
   ```

2. **Test with sample payloads**
   ```bash
   cargo lambda invoke --data-file test/fixtures/sample_slash_command.json
   ```

3. **Use ngrok to expose your local server to Slack**
   ```bash
   ngrok http 8080
   ```

## Deployment

### AWS Infrastructure

1. **Synthesize CloudFormation template**
   ```bash
   cd infrastructure
   npm run cdk synth
   ```

2. **Deploy to AWS**
   ```bash
   npm run cdk deploy
   ```

### Slack App Configuration

1. **Create a Slack app** in the [Slack API Dashboard](https://api.slack.com/apps)
2. **Add Bot Token Scopes:**
   - `chat:write`
   - `channels:history`
   - `channels:read`
   - `im:write`
3. **Enable Slash Commands:**
   - Command: `/tldr`
   - Request URL: Your API Gateway URL
   - Description: "Get a summary of unread messages in this channel"
4. **Install the app** to your workspace
5. **Update environment variables** in AWS Lambda with your Slack tokens

## Troubleshooting

- **Signature Verification Failures**: Check that your `SLACK_SIGNING_SECRET` is correctly configured
- **Permission Errors**: Ensure the Slack bot has been invited to channels and has appropriate permissions
- **No Summaries Generated**: Verify your OpenAI API key and check CloudWatch logs for specific errors
- **Message Queue Issues**: Verify the SQS queue exists and is accessible

## Future Enhancements

- **User Preferences**: Store and apply user-specific summarization preferences
- **Thread Summarization**: Add support for summarizing specific conversation threads
- **Multi-Channel Digests**: Generate summaries across multiple channels
- **DynamoDB Integration**: Persist user state and preferences
- **Additional AI Models**: Support for different language models and customization options

## Contributing

This project uses:
- Rust 2021 edition syntax and patterns
- Error handling with Result and Option types
- Async/await for asynchronous operations
- AWS CDK for infrastructure as code
- GitHub Actions for CI/CD

New contributors should focus on understanding the project structure and Rust's ownership model before making changes.

## License

MIT
