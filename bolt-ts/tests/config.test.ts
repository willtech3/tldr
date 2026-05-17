/**
 * Tests for configuration loading.
 */

import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  it('should load config from environment variables', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_SIGNING_SECRET = 'test-secret';
    process.env.PROCESSING_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/queue';

    const config = await loadConfig();

    expect(config.slackBotToken).toBe('xoxb-test-token');
    expect(config.slackSigningSecret).toBe('test-secret');
    expect(config.processingQueueUrl).toBe('https://sqs.us-east-1.amazonaws.com/123/queue');
  });

  it('should throw error when SLACK_BOT_TOKEN is missing', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN_PARAMETER_NAME;
    process.env.SLACK_SIGNING_SECRET = 'test-secret';
    process.env.PROCESSING_QUEUE_URL = 'https://sqs.test/queue';

    await expect(loadConfig()).rejects.toThrow(
      'Missing required environment variables: SLACK_BOT_TOKEN or SLACK_BOT_TOKEN_PARAMETER_NAME'
    );
  });

  it('should throw error when SLACK_SIGNING_SECRET is missing', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_SIGNING_SECRET_PARAMETER_NAME;
    process.env.PROCESSING_QUEUE_URL = 'https://sqs.test/queue';

    await expect(loadConfig()).rejects.toThrow(
      'Missing required environment variables: SLACK_SIGNING_SECRET or SLACK_SIGNING_SECRET_PARAMETER_NAME'
    );
  });

  it('should throw error when PROCESSING_QUEUE_URL is missing', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_SIGNING_SECRET = 'test-secret';
    delete process.env.PROCESSING_QUEUE_URL;

    await expect(loadConfig()).rejects.toThrow(
      'Missing required environment variables: PROCESSING_QUEUE_URL'
    );
  });

  it('should list all missing sensitive variables when multiple are missing', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN_PARAMETER_NAME;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_SIGNING_SECRET_PARAMETER_NAME;
    process.env.PROCESSING_QUEUE_URL = 'https://sqs.test/queue';

    await expect(loadConfig()).rejects.toThrow(
      'Missing required environment variables: SLACK_BOT_TOKEN or SLACK_BOT_TOKEN_PARAMETER_NAME, SLACK_SIGNING_SECRET or SLACK_SIGNING_SECRET_PARAMETER_NAME'
    );
  });
});
