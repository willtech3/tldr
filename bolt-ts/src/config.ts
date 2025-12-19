/**
 * Application configuration loaded from environment variables.
 *
 * All configuration is loaded once at cold start and validated.
 */

export interface AppConfig {
  slackBotToken: string;
  slackSigningSecret: string;
  processingQueueUrl: string;
}

/**
 * Load configuration from environment variables.
 *
 * @throws Error if required environment variables are missing
 */
export function loadConfig(): AppConfig {
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
  const processingQueueUrl = process.env.PROCESSING_QUEUE_URL;

  if (!slackBotToken || !slackSigningSecret || !processingQueueUrl) {
    const missing: string[] = [];
    if (!slackBotToken) {
      missing.push('SLACK_BOT_TOKEN');
    }
    if (!slackSigningSecret) {
      missing.push('SLACK_SIGNING_SECRET');
    }
    if (!processingQueueUrl) {
      missing.push('PROCESSING_QUEUE_URL');
    }
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return { slackBotToken, slackSigningSecret, processingQueueUrl };
}
