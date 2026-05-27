/**
 * TLDR Slack AI App — Bolt app factory.
 *
 * Wires the Assistant middleware, the style modal, and the per-summary
 * interactive buttons. All work runs inline (no SQS); long-running summary
 * generation is streamed back into the assistant thread via
 * `worker/streaming.ts`.
 */

import { App, LogLevel, Receiver } from '@slack/bolt';
import { AppConfig } from './config';
import {
  registerActionHandlers,
  registerAssistantHandlers,
  registerStyleHandlers,
} from './handlers';

export function createApp(config: AppConfig, receiver: Receiver): App {
  const app = new App({
    token: config.slackBotToken,
    receiver,
    logLevel: process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
  });

  registerAssistantHandlers(app, config);
  registerStyleHandlers(app);
  registerActionHandlers(app, config);

  return app;
}
