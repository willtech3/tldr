#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TldrStack } from '../lib/tldr-stack';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

const app = new cdk.App();

// Get AWS account ID from various sources
const accountId = app.node.tryGetContext('account') ||
  process.env.AWS_ACCOUNT_ID ||
  process.env.CDK_DEFAULT_ACCOUNT;

if (!accountId) {
  console.error('ERROR: No AWS account ID specified.');
  console.error('Please either:');
  console.error('1. Set AWS_ACCOUNT_ID in your .env file');
  console.error('2. Set account=YOUR_ACCOUNT_ID in your AWS profile config');
  console.error('3. Run with: AWS_ACCOUNT_ID=123456789012 npm run deploy');
  process.exit(1);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`ERROR: ${name} is required.`);
    process.exit(1);
  }
  return value;
}

// Create the stack with environment variables
new TldrStack(app, 'TldrStack', {
  // Stack configuration
  slackBotTokenParameterName: requiredEnv('SLACK_BOT_TOKEN_PARAMETER_NAME'),
  slackSigningSecretParameterName: requiredEnv('SLACK_SIGNING_SECRET_PARAMETER_NAME'),
  openaiApiKeyParameterName: requiredEnv('OPENAI_API_KEY_PARAMETER_NAME'),
  openaiOrgIdParameterName: process.env.OPENAI_ORG_ID_PARAMETER_NAME,
  openaiModel: process.env.OPENAI_MODEL,
  enableStreaming: process.env.ENABLE_STREAMING || 'false',
  streamMinAppendIntervalMs: process.env.STREAM_MIN_APPEND_INTERVAL_MS,
  streamMaxChunkChars: process.env.STREAM_MAX_CHUNK_CHARS,
  // Add basic environment configuration
  env: {
    account: accountId,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-2',
  },
});

app.synth();
