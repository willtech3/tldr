/**
 * Action handlers for interactive summary buttons.
 *
 * Handles:
 * - Share summary to source channel
 * - Rerun summary with Roast style
 * - Rerun summary with Receipts style
 * - Message count selection dropdown
 */

import { App, BlockAction } from '@slack/bolt';
import { v4 as uuidv4 } from 'uuid';
import { sendToSqs } from '../sqs';
import type { ProcessingTask, ThreadContext } from '../types';
import { ACTION_SELECT_MESSAGE_COUNT, buildWelcomeBlocks } from '../blocks';
import {
  buildThreadStateMetadata,
  findThreadStateMessage,
  getCachedThreadState,
  makeThreadKey,
  setCachedThreadState,
  type SlackWebApiClient,
} from '../thread_state';

/**
 * Button value metadata for Share action.
 */
interface ShareButtonValue {
  action: 'share_summary';
  sourceChannelId: string;
  count: number;
  style: string | null;
}

/**
 * Button value metadata for Rerun actions.
 */
interface RerunButtonValue {
  action: 'rerun_roast' | 'rerun_receipts';
  channelId: string;
  count: number;
}

/**
 * Register action handlers for interactive summary buttons.
 *
 * @param app - The Bolt app instance
 */
export function registerActionHandlers(app: App): void {
  const queueUrl = process.env.PROCESSING_QUEUE_URL;
  if (!queueUrl) {
    throw new Error('PROCESSING_QUEUE_URL environment variable is required');
  }

  // Handle "Share to channel" button
  app.action<BlockAction>('share_summary', async ({ ack, body, action, client, logger }) => {
    await ack();

    try {
      if (!action || typeof action !== 'object' || !('type' in action) || action.type !== 'button') {
        logger.error('Invalid action payload for share_summary');
        return;
      }

      // TypeScript doesn't narrow union types properly here, so we use any after runtime check
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buttonValue: ShareButtonValue = JSON.parse((action as any).value || '{}');
      const { sourceChannelId, count, style } = buttonValue;

      // Get thread context
      const message = 'message' in body ? body.message : null;
      const channel = 'channel' in body ? body.channel : null;

      if (!message || !channel) {
        logger.error('Could not extract message or channel from action body');
        return;
      }

      const assistantChannelId = channel.id;
      const threadTs = message.thread_ts ?? message.ts;

      // Extract the summary text from the message
      const summaryText = message.text || '';

      // Build attribution based on style
      let attribution = '';
      if (style?.toLowerCase().includes('roast')) {
        attribution = `<@${body.user.id}> chose violence and asked TLDR to roast the last ${count} messages:`;
      } else if (style?.toLowerCase().includes('receipt')) {
        attribution = `<@${body.user.id}> asked TLDR to pull receipts from the last ${count} messages:`;
      } else {
        attribution = `<@${body.user.id}> asked TLDR to summarize the last ${count} messages:`;
      }

      const sharedMessage = `${attribution}\n\n${summaryText}`;

      // Post to source channel
      await client.chat.postMessage({
        channel: sourceChannelId,
        text: sharedMessage,
      });

      // Confirm in thread
      await client.chat.postMessage({
        channel: assistantChannelId,
        thread_ts: threadTs,
        text: `✅ Shared to <#${sourceChannelId}>`,
      });

      logger.info(
        `Shared summary to channel ${sourceChannelId} from thread ${assistantChannelId}:${threadTs}`
      );
    } catch (error) {
      logger.error('Failed to handle share_summary action:', error);
    }
  });

  // Handle "Roast This" button
  app.action<BlockAction>('rerun_roast', async ({ ack, body, action, client, logger }) => {
    await ack();

    try {
      if (!action || typeof action !== 'object' || !('type' in action) || action.type !== 'button') {
        logger.error('Invalid action payload for rerun_roast');
        return;
      }

      // TypeScript doesn't narrow union types properly here, so we use any after runtime check
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buttonValue: RerunButtonValue = JSON.parse((action as any).value || '{}');
      const { channelId, count } = buttonValue;

      // Get thread context
      const message = 'message' in body ? body.message : null;
      const channel = 'channel' in body ? body.channel : null;

      if (!message || !channel) {
        logger.error('Could not extract message or channel from action body');
        return;
      }

      const assistantChannelId = channel.id;
      const threadTs = message.thread_ts ?? message.ts;

      // Post confirmation message
      await client.chat.postMessage({
        channel: assistantChannelId,
        thread_ts: threadTs,
        text: '🔥 Running roast mode...',
      });

      // Enqueue summarization task with roast style
      const task: ProcessingTask = {
        correlation_id: uuidv4(),
        user_id: body.user.id,
        channel_id: channelId,
        thread_ts: threadTs,
        origin_channel_id: assistantChannelId,
        response_url: null,
        text: `summarize last ${count}`,
        message_count: count,
        target_channel_id: null,
        custom_prompt:
          'Write in a hyper-critical, sarcastic, and roasting tone. Point out inefficiencies, poor decisions, and ridiculous behavior. Be funny but brutal.',
        visible: false,
        destination: 'Thread',
        dest_dm: false,
        dest_public_post: false,
      };

      await sendToSqs(task, queueUrl);

      logger.info(
        `Enqueued roast summary for channel ${channelId} in thread ${assistantChannelId}:${threadTs}`
      );
    } catch (error) {
      logger.error('Failed to handle rerun_roast action:', error);
    }
  });

  // Handle "Pull Receipts" button
  app.action<BlockAction>('rerun_receipts', async ({ ack, body, action, client, logger }) => {
    await ack();

    try {
      if (!action || typeof action !== 'object' || !('type' in action) || action.type !== 'button') {
        logger.error('Invalid action payload for rerun_receipts');
        return;
      }

      // TypeScript doesn't narrow union types properly here, so we use any after runtime check
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buttonValue: RerunButtonValue = JSON.parse((action as any).value || '{}');
      const { channelId, count } = buttonValue;

      // Get thread context
      const message = 'message' in body ? body.message : null;
      const channel = 'channel' in body ? body.channel : null;

      if (!message || !channel) {
        logger.error('Could not extract message or channel from action body');
        return;
      }

      const assistantChannelId = channel.id;
      const threadTs = message.thread_ts ?? message.ts;

      // Post confirmation message
      await client.chat.postMessage({
        channel: assistantChannelId,
        thread_ts: threadTs,
        text: '📜 Pulling receipts...',
      });

      // Enqueue summarization task with receipts style
      const task: ProcessingTask = {
        correlation_id: uuidv4(),
        user_id: body.user.id,
        channel_id: channelId,
        thread_ts: threadTs,
        origin_channel_id: assistantChannelId,
        response_url: null,
        text: `summarize last ${count}`,
        message_count: count,
        target_channel_id: null,
        custom_prompt:
          'Focus on finding contradictions, broken promises, and receipts. Point out when someone said they would do something and did not, or when people contradicted themselves. Be specific with timestamps and quotes.',
        visible: false,
        destination: 'Thread',
        dest_dm: false,
        dest_public_post: false,
      };

      await sendToSqs(task, queueUrl);

      logger.info(
        `Enqueued receipts summary for channel ${channelId} in thread ${assistantChannelId}:${threadTs}`
      );
    } catch (error) {
      logger.error('Failed to handle rerun_receipts action:', error);
    }
  });

  // Handle message count dropdown selection
  app.action<BlockAction>(
    ACTION_SELECT_MESSAGE_COUNT,
    async ({ ack, body, action, client, logger }) => {
      await ack();

      try {
        // Validate action is a static_select
        if (
          !action ||
          typeof action !== 'object' ||
          !('type' in action) ||
          action.type !== 'static_select'
        ) {
          logger.error('Invalid action payload for message count selection');
          return;
        }

        // Extract selected value
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const selectedOption = (action as any).selected_option;
        if (!selectedOption || typeof selectedOption.value !== 'string') {
          logger.error('No selected option in message count action');
          return;
        }

        const newCount = parseInt(selectedOption.value, 10);
        if (isNaN(newCount)) {
          logger.error('Invalid message count value:', selectedOption.value);
          return;
        }

        // Get thread context from the action body
        const message = 'message' in body ? body.message : null;
        const channel = 'channel' in body ? body.channel : null;

        if (!message || !channel) {
          logger.error('Could not extract message or channel from action body');
          return;
        }

        const assistantChannelId = channel.id;
        // The dropdown is in the welcome message, which is at the root of the thread.
        // body.message.ts is the welcome message timestamp.
        // body.message.thread_ts would be the thread root (should be same for root message).
        const welcomeMessageTs = message.ts;
        const threadTs = message.thread_ts ?? message.ts;
        const threadKey = makeThreadKey(assistantChannelId, threadTs);

        // Load current thread state
        let currentState: ThreadContext = {
          viewingChannelId: null,
          customStyle: null,
          defaultMessageCount: null,
        };

        const cached = getCachedThreadState(threadKey);
        if (cached) {
          currentState = cached.state;
        } else {
          // Try loading from Slack metadata
          try {
            const loaded = await findThreadStateMessage({
              client: client as unknown as SlackWebApiClient,
              assistantChannelId,
              assistantThreadTs: threadTs,
            });
            if (loaded) {
              currentState = loaded.state;
            }
          } catch (error) {
            logger.warn('Failed to load thread state from Slack:', error);
          }
        }

        // Update state with new message count
        const nextState: ThreadContext = {
          ...currentState,
          defaultMessageCount: newCount,
        };

        // Persist to welcome message metadata via chat.update
        await client.chat.update({
          channel: assistantChannelId,
          ts: welcomeMessageTs,
          text: 'Welcome to TLDR',
          blocks: buildWelcomeBlocks(
            nextState.viewingChannelId,
            nextState.customStyle,
            nextState.defaultMessageCount
          ),
          metadata: buildThreadStateMetadata(nextState),
        });

        // Update cache
        setCachedThreadState({
          threadKey,
          stateMessageTs: welcomeMessageTs,
          state: nextState,
        });

        logger.info(
          `Updated default message count to ${newCount} for thread ${assistantChannelId}:${threadTs}`
        );
      } catch (error) {
        logger.error('Failed to handle message count selection:', error);
      }
    }
  );
}
