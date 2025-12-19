/**
 * Assistant thread event handlers.
 *
 * Handles Slack AI App assistant events:
 * - assistant_thread_started
 * - assistant_thread_context_changed
 */

import { App } from '@slack/bolt';
import { buildWelcomeBlocks } from '../blocks';

// Event types for assistant thread events
interface AssistantThread {
  channel_id: string;
  thread_ts: string;
  context?: {
    channel_id?: string;
  };
}

/**
 * Default suggested prompts shown when assistant thread starts.
 */
const DEFAULT_PROMPTS = ['Summarize recent', 'Summarize last 50', 'Help', 'Configure'];

/**
 * Register assistant thread event handlers.
 *
 * @param app - The Bolt app instance
 */
export function registerAssistantHandlers(app: App): void {
  // Handle assistant thread started
  app.event('assistant_thread_started', async ({ event, client, logger }) => {
    // Extract assistant_thread from the event
    const assistantThread = (event as { assistant_thread?: AssistantThread }).assistant_thread;

    if (!assistantThread) {
      logger.warn('assistant_thread_started event missing assistant_thread');
      return;
    }

    const channelId = assistantThread.channel_id;
    const threadTs = assistantThread.thread_ts;

    if (!channelId || !threadTs) {
      logger.warn('assistant_thread_started missing channel_id or thread_ts');
      return;
    }

    try {
      // Set suggested prompts (fire and forget - don't block ACK)
      client.assistant.threads
        .setSuggestedPrompts({
          channel_id: channelId,
          thread_ts: threadTs,
          prompts: DEFAULT_PROMPTS.map((title) => ({ title, message: title })),
        })
        .catch((err) => logger.error('Failed to set suggested prompts:', err));

      // Post welcome message
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'Welcome to TLDR Bot',
        blocks: buildWelcomeBlocks(),
      });

      logger.info(`Assistant thread started in ${channelId}`);
    } catch (error) {
      logger.error('Error handling assistant_thread_started:', error);
    }
  });

  // Handle context changes (user navigating to different channels)
  app.event('assistant_thread_context_changed', async ({ event, logger }) => {
    // Extract assistant_thread from the event
    const assistantThread = (event as { assistant_thread?: AssistantThread }).assistant_thread;

    if (!assistantThread) {
      logger.warn('assistant_thread_context_changed missing assistant_thread');
      return;
    }

    // Context is tracked via the event payload - the channel_context field
    // tells us what channel the user is currently viewing.
    // For V1, we use this implicitly in summarize commands.
    // Future: Store in thread metadata for explicit tracking.
    const context = assistantThread.context;
    if (context) {
      logger.info(`Context changed: channel=${context.channel_id}`);
    }
  });
}
