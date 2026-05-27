/**
 * Tests for configuration loading.
 */

import { loadConfig, resetConfigCacheForTests } from '../src/config';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfigCacheForTests();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('loads required values from plain env vars', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_SIGNING_SECRET = 'test-secret';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    delete process.env.SLACK_BOT_TOKEN_PARAMETER_NAME;
    delete process.env.SLACK_SIGNING_SECRET_PARAMETER_NAME;
    delete process.env.ANTHROPIC_API_KEY_PARAMETER_NAME;

    const config = await loadConfig();

    expect(config.slackBotToken).toBe('xoxb-test-token');
    expect(config.slackSigningSecret).toBe('test-secret');
    expect(config.anthropicApiKey).toBe('sk-ant-test');
    expect(config.anthropicModel).toBe('claude-sonnet-4-6');
    expect(config.anthropicMaxOutputTokens).toBeGreaterThan(0);
    expect(config.enableStreaming).toBe(true);
    expect(config.streamMaxChunkChars).toBeGreaterThan(0);
    expect(config.streamMinAppendIntervalMs).toBeGreaterThan(0);
  });

  it('honours ANTHROPIC_MODEL override', async () => {
    process.env.SLACK_BOT_TOKEN = 'x';
    process.env.SLACK_SIGNING_SECRET = 'y';
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-7';
    const config = await loadConfig();
    expect(config.anthropicModel).toBe('claude-opus-4-7');
  });

  it('honours ANTHROPIC_MAX_OUTPUT_TOKENS override and caps at 64000', async () => {
    process.env.SLACK_BOT_TOKEN = 'x';
    process.env.SLACK_SIGNING_SECRET = 'y';
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    process.env.ANTHROPIC_MAX_OUTPUT_TOKENS = '999999';
    const config = await loadConfig();
    expect(config.anthropicMaxOutputTokens).toBe(64_000);
  });

  it('parses ENABLE_STREAMING as boolean', async () => {
    process.env.SLACK_BOT_TOKEN = 'x';
    process.env.SLACK_SIGNING_SECRET = 'y';
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    process.env.ENABLE_STREAMING = '0';
    let config = await loadConfig();
    expect(config.enableStreaming).toBe(false);

    resetConfigCacheForTests();
    process.env.ENABLE_STREAMING = 'yes';
    config = await loadConfig();
    expect(config.enableStreaming).toBe(true);
  });

  it('throws when SLACK_BOT_TOKEN is missing', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN_PARAMETER_NAME;
    process.env.SLACK_SIGNING_SECRET = 'y';
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    await expect(loadConfig()).rejects.toThrow(/SLACK_BOT_TOKEN/);
  });

  it('throws when ANTHROPIC_API_KEY is missing', async () => {
    process.env.SLACK_BOT_TOKEN = 'x';
    process.env.SLACK_SIGNING_SECRET = 'y';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY_PARAMETER_NAME;
    await expect(loadConfig()).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('lists all missing variables in a single error', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN_PARAMETER_NAME;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_SIGNING_SECRET_PARAMETER_NAME;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY_PARAMETER_NAME;
    await expect(loadConfig()).rejects.toThrow(
      /SLACK_BOT_TOKEN.*SLACK_SIGNING_SECRET.*ANTHROPIC_API_KEY/
    );
  });

  it('caps streamMaxChunkChars at the documented Slack limit', async () => {
    process.env.SLACK_BOT_TOKEN = 'x';
    process.env.SLACK_SIGNING_SECRET = 'y';
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    process.env.STREAM_MAX_CHUNK_CHARS = '99999';
    const config = await loadConfig();
    expect(config.streamMaxChunkChars).toBeLessThanOrEqual(12000);
  });
});
