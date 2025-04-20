# TLDR

A Rust-based Slack bot that summarizes unread messages in user-specified channels using ChatGPT.

## Application Functionality

TLDR is a powerful Slack bot that helps users catch up on conversations they've missed. With a simple slash command, users can get an AI-generated summary of all unread messages in a channel, delivered directly to them as a DM.

### Key Features

- **Unread Message Summarization**: Get concise summaries of all unread messages in a channel
- **ChatGPT Integration**: Utilizes OpenAI's ChatGPT for high-quality, contextual summaries
- **Asynchronous Processing**: Non-blocking architecture ensures responsive user experience
- **Secure Authentication**: Implements Slack's security standards for request verification
- **Error Handling**: Robust error handling for API failures and processing errors
- **Serverless Architecture**: Low-cost, scalable AWS Lambda infrastructure

### User Experience

Users interact with the bot through a slash command:
```
/tldr [options]
```

The bot then:
1. Authenticates the request
2. Acknowledges receipt of the command
3. Retrieves unread messages from the channel
4. Generates a summary using ChatGPT
5. Sends the summary as a direct message to the user

## Development Environment Setup

### Prerequisites

- **Rust** (latest stable version)
  - cargo
  - cargo-lambda for Lambda function building
- **Node.js** (v18+) and npm for CDK
- **AWS CLI** configured with appropriate permissions
- **Slack Workspace** with admin privileges for bot installation
- **OpenAI API** key for ChatGPT integration

### Local Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/TLDR.git
   cd TLDR
   ```

2. **Set up environment variables**
   Create a `.env` file with:
   ```
   SLACK_BOT_TOKEN=xoxb-your-token
   SLACK_SIGNING_SECRET=your-signing-secret
   OPENAI_API_KEY=your-openai-key
   PROCESSING_QUEUE_URL=your-sqs-queue-url (for local testing)
   ```

3. **Install Rust dependencies**
   ```bash
   cd lambda
   cargo build
   ```

4. **Install Node.js dependencies for CDK**
   ```bash
   cd ../infrastructure
   npm install
   ```

5. **Install cargo-lambda for local testing and deployment**
   ```bash
   cargo install cargo-lambda
   ```

6. **Run tests**
   ```bash
   cd ../lambda
   cargo test
   ```

### Local Testing

1. **Build the Lambda function**
   ```bash
   cargo lambda build
   ```

2. **Run the Lambda function locally**
   ```bash
   cargo lambda watch
   ```

3. **Use a tool like ngrok to expose your local server**
   ```bash
   ngrok http 8080
   ```

4. **Update your Slack app's request URL to your ngrok URL**

## Application Architecture

### System Components

1. **Slack Integration Layer**
   - Handles Slack API interactions
   - Manages webhooks and event subscriptions
   - Processes slash commands

2. **API Lambda Function (tldr-api)**
   - Receives and validates Slack requests
   - Performs signature verification
   - Queues tasks for asynchronous processing
   - Provides immediate user feedback

3. **Worker Lambda Function (tldr-worker)**
   - Processes queued summarization tasks
   - Retrieves unread messages from channels
   - Interacts with OpenAI API for summarization
   - Delivers summaries through Slack DMs

4. **Infrastructure**
   - AWS SQS for message queuing
   - AWS Lambda for compute
   - API Gateway for endpoint exposure
   - DynamoDB for state persistence (future)
   - CloudWatch for logging and monitoring

### Data Flow

```
Slack User → Slack Workspace → API Gateway → API Lambda → SQS → Worker Lambda → OpenAI API → Slack API → User DM
```

### Code Organization

- **`/lambda`**: Rust code for Lambda functions
  - `/src/bin/api.rs`: Entry point for API Lambda
  - `/src/bin/worker.rs`: Entry point for Worker Lambda
  - `/src/lib.rs`: Shared functionality
  - `/src/slack_parser.rs`: Parsing Slack requests

- **`/infrastructure`**: AWS CDK code for deployment
  - Defines AWS resources and their relationships
  - Manages deployment parameters and configurations

- **`/.github/workflows`**: CI/CD pipelines
  - Automated testing, building, and deployment

## Deployment

### AWS Infrastructure Deployment

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

1. **Create a Slack app in the [Slack API Dashboard](https://api.slack.com/apps)**
2. **Add Bot Token Scopes:**
   - `chat:write`
   - `channels:history`
   - `channels:read`
   - `im:write`
3. **Enable Slash Commands:**
   - Command: `/tldr`
   - Request URL: Your API Gateway URL
   - Description: "Get a summary of unread messages in this channel"
4. **Install the app to your workspace**
5. **Update environment variables in AWS Lambda with your Slack tokens**

### CI/CD Pipeline

The project uses GitHub Actions for continuous integration and deployment:

1. **Automated Testing**: Runs on pull requests and commits to main
2. **Build**: Compiles the Rust code and prepares Lambda deployment packages
3. **Deploy**: Updates AWS infrastructure using CDK
4. **Monitoring**: Sets up CloudWatch alarms for error notifications

## Troubleshooting

- **Signature Verification Failures**: Check that your `SLACK_SIGNING_SECRET` is correctly configured
- **Permission Errors**: Ensure the Slack bot has been invited to channels and has appropriate permissions
- **Summarization Issues**: Verify your OpenAI API key and check OpenAI API status

## Future Enhancements

- User preference storage in DynamoDB
- Custom summarization options
- Thread-specific summaries
- Multi-channel digests
- Scheduled summaries (daily/weekly)

## License

MIT
