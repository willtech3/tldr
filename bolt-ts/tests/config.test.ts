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

  it('should load config from environment variables', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_SIGNING_SECRET = 'test-secret';
    process.env.PROCESSING_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/queue';

    const config = loadConfig();

    expect(config.slackBotToken).toBe('xoxb-test-token');
    expect(config.slackSigningSecret).toBe('test-secret');
    expect(config.processingQueueUrl).toBe('https://sqs.us-east-1.amazonaws.com/123/queue');
  });

  it('should throw error when SLACK_BOT_TOKEN is missing', () => {
    delete process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_SIGNING_SECRET = 'test-secret';
    process.env.PROCESSING_QUEUE_URL = 'https://sqs.test/queue';

    expect(() => loadConfig()).toThrow('Missing required environment variables: SLACK_BOT_TOKEN');
  });

  it('should throw error when SLACK_SIGNING_SECRET is missing', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    delete process.env.SLACK_SIGNING_SECRET;
    process.env.PROCESSING_QUEUE_URL = 'https://sqs.test/queue';

    expect(() => loadConfig()).toThrow('Missing required environment variables: SLACK_SIGNING_SECRET');
  });

  it('should throw error when PROCESSING_QUEUE_URL is missing', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_SIGNING_SECRET = 'test-secret';
    delete process.env.PROCESSING_QUEUE_URL;

    expect(() => loadConfig()).toThrow('Missing required environment variables: PROCESSING_QUEUE_URL');
  });

  it('should list all missing variables when multiple are missing', () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.PROCESSING_QUEUE_URL;

    expect(() => loadConfig()).toThrow(
      'Missing required environment variables: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, PROCESSING_QUEUE_URL'
    );
  });
});
