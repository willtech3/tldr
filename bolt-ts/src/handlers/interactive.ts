/**
 * Interactive component handlers.
 *
 * Handles block actions from interactive components.
 * Note: Message/global shortcuts are intentionally NOT supported per the
 * AI App rewrite spec - AI App UX should use assistant threads exclusively.
 */

import { App, BlockAction, ConversationsSelectAction } from '@slack/bolt';
import { v4 as uuidv4 } from 'uuid';
import { sendToSqs } from '../sqs';
import { ProcessingTask } from '../types';
import { AppConfig } from '../config';

/**
 * Register interactive component handlers.
 *
 * @param app - The Bolt app instance
 * @param config - Application configuration
 */
export function registerInteractiveHandlers(app: App, config: AppConfig): void {
  // Handle conversation picker selection
  app.action<BlockAction<ConversationsSelectAction>>('tldr_pick_conv', async ({ body, action, ack, client, logger }) => {
    await ack();

    const selectedChannel = action.selected_conversation;
    if (!selectedChannel) {
      logger.warn('No channel selected in tldr_pick_conv action');
      return;
    }

    const userId = body.user.id;
    const channelId = body.channel?.id;

    // Get thread_ts from the message that contained the picker
    const message = 'message' in body ? body.message : null;
    const threadTs = message?.thread_ts || message?.ts;

    if (!channelId || !threadTs) {
      logger.warn('Missing channel or thread context for tldr_pick_conv');
      return;
    }

    // Parse the block_id to determine intent
    // Format: tldr_pick_lastn_N, tldr_pick_recent, or tldr_pick_config
    const blockId = action.block_id || '';
    let messageCount: number | null = null;

    if (blockId.startsWith('tldr_pick_lastn_')) {
      const countStr = blockId.replace('tldr_pick_lastn_', '');
      const parsed = parseInt(countStr, 10);
      if (!isNaN(parsed)) {
        messageCount = parsed;
      }
    }

    // Check if this is a config picker
    if (blockId === 'tldr_pick_config') {
      // TODO: PR 4 - Open style configuration modal
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Configuration for <#${selectedChannel}> coming soon!`,
      });
      return;
    }

    // Build and enqueue processing task
    const task: ProcessingTask = {
      correlation_id: uuidv4(),
      user_id: userId,
      channel_id: selectedChannel,
      thread_ts: threadTs,
      origin_channel_id: channelId,
      response_url: null,
      text: '',
      message_count: messageCount,
      target_channel_id: null,
      custom_prompt: null,
      visible: false,
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

      logger.info(`Enqueued summarize task ${task.correlation_id} for channel ${selectedChannel}`);
    } catch (error) {
      logger.error('Failed to enqueue task:', error);
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: "Sorry, I couldn't generate a summary at this time. Please try again later.",
      });
    }
  });
}
