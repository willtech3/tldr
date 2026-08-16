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
  registerMentionHandlers,
  registerShortcutHandlers,
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
  registerShortcutHandlers(app, config);
  registerMentionHandlers(app, config);

  // Slack's new agent experience (manifest `agent_view`) emits
  // app_context_changed on every view switch. The useful context for us
  // rides the `app_context` field of message.im events (see
  // handlers/assistant.ts appContextChannelId), so this event only needs an
  // ack — but without a listener Bolt logs every delivery as an unhandled
  // request. Never fires under the current assistant_view manifest.
  app.event('app_context_changed', async (): Promise<void> => {});

  return app;
}
