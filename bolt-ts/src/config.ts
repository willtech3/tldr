/**
 * Application configuration loaded from environment variables.
 *
 * All configuration is loaded once at cold start and validated.
 */

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export interface AppConfig {
  slackBotToken: string;
  slackSigningSecret: string;
  processingQueueUrl: string;
}

let ssmClient: SSMClient | null = null;

function getSsmClient(): SSMClient {
  if (!ssmClient) {
    ssmClient = new SSMClient({});
  }
  return ssmClient;
}

async function loadSensitiveValue(envName: string, parameterEnvName: string): Promise<string> {
  const parameterName = process.env[parameterEnvName]?.trim();
  if (parameterName) {
    const response = await getSsmClient().send(
      new GetParameterCommand({
        Name: parameterName,
        WithDecryption: true,
      })
    );

    const value = response.Parameter?.Value;
    if (!value) {
      throw new Error(`SSM parameter ${parameterEnvName} did not contain a value`);
    }
    return value;
  }

  const value = process.env[envName];
  if (!value) {
    throw new Error(`Missing required environment variable: ${envName}`);
  }
  return value;
}

/**
 * Load configuration from environment variables.
 *
 * @throws Error if required environment variables are missing
 */
export async function loadConfig(): Promise<AppConfig> {
  const processingQueueUrl = process.env.PROCESSING_QUEUE_URL;

  if (!processingQueueUrl) {
    throw new Error('Missing required environment variables: PROCESSING_QUEUE_URL');
  }

  const missingSensitive: string[] = [];
  if (!process.env.SLACK_BOT_TOKEN && !process.env.SLACK_BOT_TOKEN_PARAMETER_NAME) {
    missingSensitive.push('SLACK_BOT_TOKEN or SLACK_BOT_TOKEN_PARAMETER_NAME');
  }
  if (!process.env.SLACK_SIGNING_SECRET && !process.env.SLACK_SIGNING_SECRET_PARAMETER_NAME) {
    missingSensitive.push('SLACK_SIGNING_SECRET or SLACK_SIGNING_SECRET_PARAMETER_NAME');
  }

  if (missingSensitive.length > 0) {
    const missing: string[] = [];
    missing.push(...missingSensitive);
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const slackBotToken = await loadSensitiveValue('SLACK_BOT_TOKEN', 'SLACK_BOT_TOKEN_PARAMETER_NAME');
  const slackSigningSecret = await loadSensitiveValue(
    'SLACK_SIGNING_SECRET',
    'SLACK_SIGNING_SECRET_PARAMETER_NAME'
  );

  return { slackBotToken, slackSigningSecret, processingQueueUrl };
}
