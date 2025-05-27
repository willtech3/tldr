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

// Create the stack with environment variables
new TldrStack(app, 'TldrStack', {
  // Stack configuration
  slackBotToken: process.env.SLACK_BOT_TOKEN || '',
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiOrgId: process.env.OPENAI_ORG_ID || '',
  // Add basic environment configuration
  env: {
    account: accountId,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});

app.synth();
