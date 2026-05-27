/**
 * Application configuration loaded from environment variables and SSM Parameter Store.
 *
 * All configuration is loaded once at cold start, cached on the module, and validated.
 */

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MODEL } from './ai/anthropic';

export interface AppConfig {
  slackBotToken: string;
  slackSigningSecret: string;
  anthropicApiKey: string;
  anthropicModel: string;
  anthropicMaxOutputTokens: number;
  enableStreaming: boolean;
  streamMaxChunkChars: number;
  streamMinAppendIntervalMs: number;
}

/** Slack's documented per-call character limit for `markdown_text` in chat.*Stream APIs. */
export const STREAM_MARKDOWN_TEXT_LIMIT = 12_000;
/**
 * Default chunk size for streaming appends. Modern models pump tokens fast
 * enough that larger chunks reduce Slack API calls without harming perceived
 * responsiveness. We keep headroom below Slack's 12K hard limit.
 */
const DEFAULT_STREAM_MAX_CHUNK_CHARS = 8_000;
/**
 * Default minimum interval between `chat.appendStream` calls. Slack's append
 * is Tier 4 (100+/min), so 500 ms is comfortably under the limit while keeping
 * the stream feeling live.
 */
const DEFAULT_STREAM_MIN_APPEND_INTERVAL_MS = 500;

let ssmClient: SSMClient | null = null;
let cachedConfig: AppConfig | null = null;

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
      new GetParameterCommand({ Name: parameterName, WithDecryption: true })
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

function parseBool(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw.trim().toLowerCase());
}

function parsePositiveInt(raw: string | undefined, fallback: number, max?: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  if (max !== undefined && parsed > max) {
    return max;
  }
  return parsed;
}

/**
 * Load configuration from environment variables and SSM. Validates required inputs.
 *
 * @throws Error if required configuration is missing.
 */
export async function loadConfig(): Promise<AppConfig> {
  const missingSensitive: string[] = [];
  if (!process.env.SLACK_BOT_TOKEN && !process.env.SLACK_BOT_TOKEN_PARAMETER_NAME) {
    missingSensitive.push('SLACK_BOT_TOKEN or SLACK_BOT_TOKEN_PARAMETER_NAME');
  }
  if (!process.env.SLACK_SIGNING_SECRET && !process.env.SLACK_SIGNING_SECRET_PARAMETER_NAME) {
    missingSensitive.push('SLACK_SIGNING_SECRET or SLACK_SIGNING_SECRET_PARAMETER_NAME');
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY_PARAMETER_NAME) {
    missingSensitive.push('ANTHROPIC_API_KEY or ANTHROPIC_API_KEY_PARAMETER_NAME');
  }

  if (missingSensitive.length > 0) {
    throw new Error(`Missing required environment variables: ${missingSensitive.join(', ')}`);
  }

  const [slackBotToken, slackSigningSecret, anthropicApiKey] = await Promise.all([
    loadSensitiveValue('SLACK_BOT_TOKEN', 'SLACK_BOT_TOKEN_PARAMETER_NAME'),
    loadSensitiveValue('SLACK_SIGNING_SECRET', 'SLACK_SIGNING_SECRET_PARAMETER_NAME'),
    loadSensitiveValue('ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_PARAMETER_NAME'),
  ]);

  const streamMaxChunkChars = parsePositiveInt(
    process.env.STREAM_MAX_CHUNK_CHARS,
    DEFAULT_STREAM_MAX_CHUNK_CHARS,
    STREAM_MARKDOWN_TEXT_LIMIT
  );
  const streamMinAppendIntervalMs = parsePositiveInt(
    process.env.STREAM_MIN_APPEND_INTERVAL_MS,
    DEFAULT_STREAM_MIN_APPEND_INTERVAL_MS
  );
  const anthropicMaxOutputTokens = parsePositiveInt(
    process.env.ANTHROPIC_MAX_OUTPUT_TOKENS,
    DEFAULT_MAX_OUTPUT_TOKENS,
    64_000
  );

  return {
    slackBotToken,
    slackSigningSecret,
    anthropicApiKey,
    anthropicModel: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
    anthropicMaxOutputTokens,
    enableStreaming: process.env.ENABLE_STREAMING === undefined
      ? true
      : parseBool(process.env.ENABLE_STREAMING),
    streamMaxChunkChars,
    streamMinAppendIntervalMs,
  };
}

/** Load and cache the config. Subsequent invocations on a warm Lambda return the cached value. */
export async function loadConfigCached(): Promise<AppConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }
  cachedConfig = await loadConfig();
  return cachedConfig;
}

/** For tests. */
export function resetConfigCacheForTests(): void {
  cachedConfig = null;
}
