/**
 * Message event handlers.
 *
 * Handles message events in assistant threads (message.im).
 *
 * Note: Channel pickers are intentionally NOT used per the AI App rewrite spec.
 * Context tracking via assistant_thread_context_changed is implemented in PR 3.
 */

import { App } from '@slack/bolt';
import { v4 as uuidv4 } from 'uuid';
import { parseUserIntent } from '../intent';
import { buildHelpBlocks, buildConfigurePickerBlocks } from '../blocks';
import { sendToSqs } from '../sqs';
import { ProcessingTask } from '../types';
import { AppConfig } from '../config';

// Basic message event type for our use case
interface MessageEvent {
  type: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

/**
 * Register message event handlers.
 *
 * @param app - The Bolt app instance
 * @param config - Application configuration
 */
export function registerMessageHandlers(app: App, config: AppConfig): void {
  // Handle direct messages (assistant thread messages)
  app.event('message', async ({ event, client, logger }) => {
    // Type guard for generic message events
    const msg = event as MessageEvent;

    // Ignore bot messages and edited/system messages to avoid loops
    if (msg.bot_id || msg.subtype) {
      return;
    }

    const channelId = msg.channel;
    const threadTs = msg.thread_ts || msg.ts;
    const text = msg.text || '';
    const userId = msg.user;

    if (!channelId || !userId) {
      return;
    }

    const intent = parseUserIntent(text);

    try {
      switch (intent.type) {
        case 'help': {
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: 'TLDR Bot Help',
            blocks: buildHelpBlocks(),
          });
          break;
        }

        case 'customize': {
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: 'Pick conversation',
            blocks: buildConfigurePickerBlocks(),
          });
          break;
        }

        case 'summarize': {
          // If no channel specified, inform the user
          // Note: PR 3 will implement context tracking via assistant_thread_context_changed
          if (!intent.targetChannel) {
            await client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: 'Please specify a channel to summarize, e.g., "summarize #general" or "summarize last 50 #random".',
            });
            return;
          }

          // Build and enqueue processing task
          const task: ProcessingTask = {
            correlation_id: uuidv4(),
            user_id: userId,
            channel_id: intent.targetChannel,
            thread_ts: threadTs,
            origin_channel_id: channelId,
            response_url: null,
            text: text.toLowerCase(),
            message_count: intent.count,
            target_channel_id: null,
            custom_prompt: null,
            visible: intent.postHere,
            destination: 'Thread',
            dest_dm: false,
            dest_public_post: false,
          };

          try {
            await sendToSqs(task, config.processingQueueUrl);

            // Set status to show we're processing
            client.assistant.threads
              .setStatus({
                channel_id: channelId,
                thread_ts: threadTs,
                status: 'Summarizing...',
              })
              .catch((err) => logger.error('Failed to set status:', err));

            logger.info(`Enqueued summarize task ${task.correlation_id}`);
          } catch (sqsError) {
            logger.error('Failed to enqueue task:', sqsError);
            await client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: "Sorry, I couldn't generate a summary at this time. Please try again later.",
            });
          }
          break;
        }

        case 'unknown':
        default:
          // Silently ignore unknown commands
          break;
      }
    } catch (error) {
      logger.error('Error handling message:', error);
    }
  });
}
