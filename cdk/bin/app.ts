#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TldrStack } from '../lib/tldr-stack';
import * as dotenv from 'dotenv';

dotenv.config();

const app = new cdk.App();

const accountId =
  app.node.tryGetContext('account') ||
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

new TldrStack(app, 'TldrStack', {
  slackBotTokenParameterName: requiredEnv('SLACK_BOT_TOKEN_PARAMETER_NAME'),
  slackSigningSecretParameterName: requiredEnv('SLACK_SIGNING_SECRET_PARAMETER_NAME'),
  anthropicApiKeyParameterName: requiredEnv('ANTHROPIC_API_KEY_PARAMETER_NAME'),
  anthropicModel: process.env.ANTHROPIC_MODEL,
  anthropicMaxOutputTokens: process.env.ANTHROPIC_MAX_OUTPUT_TOKENS,
  enableStreaming: process.env.ENABLE_STREAMING || 'true',
  streamMinAppendIntervalMs: process.env.STREAM_MIN_APPEND_INTERVAL_MS,
  streamMaxChunkChars: process.env.STREAM_MAX_CHUNK_CHARS,
  env: {
    account: accountId,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-2',
  },
});

app.synth();
