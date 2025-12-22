/**
 * TLDR Slack AI App - Bolt TypeScript Application
 *
 * This is the main Bolt app configuration. It handles:
 * - Assistant thread events (thread_started, context_changed)
 * - Message events in assistant threads
 * - Interactive components (style modal)
 *
 * The app is designed to:
 * - ACK Slack requests within 3 seconds (fast ACK requirement)
 * - Enqueue heavy work to SQS for async processing
 * - Use minimal Slack API calls in the request path
 */

import { App, LogLevel, Receiver } from '@slack/bolt';
import { AppConfig } from './config';
import {
  registerAssistantHandlers,
  registerStyleHandlers,
  registerActionHandlers,
} from './handlers';

/**
 * Create and configure the Bolt app instance.
 *
 * @param config - Application configuration
 * @param receiver - The receiver to use (e.g., AwsLambdaReceiver)
 * @returns Configured Bolt app
 */
export function createApp(config: AppConfig, receiver: Receiver): App {
  const app = new App({
    token: config.slackBotToken,
    receiver,
    // Use process environment for logging
    logLevel: process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
  });

  // Register all handlers
  // Note: registerAssistantHandlers uses the Assistant class which handles
  // assistant_thread_started, assistant_thread_context_changed, and message.im events
  registerAssistantHandlers(app, config);
  registerStyleHandlers(app);
  registerActionHandlers(app);

  return app;
}
