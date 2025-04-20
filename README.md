# tldr

A Slack bot that allows users to summarize unread messages in specified channels.

## Architecture

This application consists of:
- A Slack bot that interacts with users in a workspace
- An AWS Lambda function (written in Rust) that processes requests and summarizes messages
- AWS CDK infrastructure (TypeScript) to deploy the application 

## Features

- Summarize unread messages in user-specified channels
- Simple slash commands to control the bot
- Support for authentication and authorization with Slack
- Configurable summarization options

## Development

### Prerequisites

- Rust (latest stable)
- Node.js 18+
- AWS CLI configured
- Slack workspace with admin privileges (for bot installation)

### Local Development

1. Set up local environment variables
2. Run the CDK synth to generate CloudFormation templates
3. Deploy with CDK
4. Configure the Slack application in Slack API dashboard

### Deployment

This project uses GitHub Actions for CI/CD. See the workflows in `.github/workflows/`.

## License

MIT
