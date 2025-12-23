/**
 * Style-related action and view handlers.
 *
 * Handles:
 * - Button click to open the "Set style" modal
 * - Modal submission to save the style
 */

import { App, BlockAction } from '@slack/bolt';
import {
  ACTION_OPEN_STYLE_MODAL,
  MODAL_CALLBACK_SET_STYLE,
  INPUT_BLOCK_STYLE,
  INPUT_ACTION_STYLE,
  buildStyleModal,
  buildStyleConfirmationBlocks,
  buildWelcomeBlocks,
  type StyleModalPrivateMetadata,
} from '../blocks';
import {
  buildThreadStateMetadata,
  findThreadStateMessage,
  getCachedThreadState,
  makeThreadKey,
  setCachedThreadState,
  type SlackWebApiClient,
} from '../thread_state';
import type { ThreadContext } from '../types';

const WELCOME_TEXT = 'Welcome to TLDR';

/**
 * Register style-related action and view handlers.
 *
 * @param app - The Bolt app instance
 */
export function registerStyleHandlers(app: App): void {
  // Handle "Set style" button click - opens the style modal
  app.action<BlockAction>(ACTION_OPEN_STYLE_MODAL, async ({ ack, body, client, logger }) => {
    // Acknowledge immediately (Slack requires response within 3 seconds)
    await ack();

    // Extract thread context from the action payload
    const triggerId = body.trigger_id;
    if (!triggerId) {
      logger.error('No trigger_id in action payload');
      return;
    }

    // Get channel and thread info from the message containing the button
    const message = 'message' in body ? body.message : null;
    const channel = 'channel' in body ? body.channel : null;

    if (!message || !channel) {
      logger.error('Could not extract message or channel from action body');
      return;
    }

    const channelId = channel.id;
    // For thread replies, thread_ts points to the parent; for parent messages, use ts
    const threadTs = message.thread_ts ?? message.ts;

    if (!channelId || !threadTs) {
      logger.error('Missing channel_id or thread_ts in action payload');
      return;
    }

    // Get current style from cache, falling back to Slack metadata on cache miss
    const threadKey = makeThreadKey(channelId, threadTs);
    let cached = getCachedThreadState(threadKey);

    // On cache miss (cold start), load state from Slack metadata
    if (!cached) {
      try {
        cached = await findThreadStateMessage({
          client: client as unknown as SlackWebApiClient,
          assistantChannelId: channelId,
          assistantThreadTs: threadTs,
        });
      } catch (error) {
        logger.warn('Failed to load thread state from Slack:', error);
      }
    }

    const currentStyle = cached?.state.customStyle ?? null;

    const privateMetadata: StyleModalPrivateMetadata = {
      assistantChannelId: channelId,
      assistantThreadTs: threadTs,
    };

    try {
      await client.views.open({
        trigger_id: triggerId,
        view: buildStyleModal(currentStyle, privateMetadata),
      });
    } catch (error) {
      logger.error('Failed to open style modal:', error);
    }
  });

  // Handle style modal submission
  app.view(MODAL_CALLBACK_SET_STYLE, async ({ ack, view, client, logger }) => {
    // Acknowledge immediately
    await ack();

    // Parse private metadata to get thread context
    let privateMetadata: StyleModalPrivateMetadata;
    try {
      privateMetadata = JSON.parse(view.private_metadata) as StyleModalPrivateMetadata;
    } catch {
      logger.error('Failed to parse private_metadata from style modal');
      return;
    }

    const { assistantChannelId, assistantThreadTs } = privateMetadata;

    // Extract the style value from the submission
    const styleInput = view.state.values[INPUT_BLOCK_STYLE]?.[INPUT_ACTION_STYLE];
    const newStyle = styleInput?.value?.trim() || null;

    const threadKey = makeThreadKey(assistantChannelId, assistantThreadTs);

    // Get existing state from cache, falling back to Slack metadata on cache miss
    let cached = getCachedThreadState(threadKey);
    if (!cached) {
      try {
        cached = await findThreadStateMessage({
          client: client as unknown as SlackWebApiClient,
          assistantChannelId,
          assistantThreadTs,
        });
      } catch (error) {
        logger.warn('Failed to load thread state from Slack:', error);
      }
    }

    // Preserve viewingChannelId and defaultMessageCount from the loaded state
    const nextState: ThreadContext = {
      viewingChannelId: cached?.state.viewingChannelId ?? null,
      customStyle: newStyle,
      defaultMessageCount: cached?.state.defaultMessageCount ?? null,
    };

    // Update the canonical thread state message (or create if truly missing)
    const stateMessageTs = cached?.state_message_ts;
    if (stateMessageTs) {
      try {
        await client.chat.update({
          channel: assistantChannelId,
          ts: stateMessageTs,
          text: WELCOME_TEXT,
          blocks: buildWelcomeBlocks(
            nextState.viewingChannelId,
            newStyle,
            nextState.defaultMessageCount
          ),
          metadata: buildThreadStateMetadata(nextState),
        });
        setCachedThreadState({ threadKey, stateMessageTs, state: nextState });
      } catch (error) {
        logger.error('Failed to update thread state message:', error);
      }
    } else {
      // If no state message exists (unexpected), create one
      try {
        const resp = await client.chat.postMessage({
          channel: assistantChannelId,
          thread_ts: assistantThreadTs,
          text: WELCOME_TEXT,
          blocks: buildWelcomeBlocks(
            nextState.viewingChannelId,
            newStyle,
            nextState.defaultMessageCount
          ),
          metadata: buildThreadStateMetadata(nextState),
        });
        if (resp.ts) {
          setCachedThreadState({ threadKey, stateMessageTs: resp.ts, state: nextState });
        }
      } catch (error) {
        logger.error('Failed to create thread state message:', error);
      }
    }

    // Post confirmation message
    try {
      await client.chat.postMessage({
        channel: assistantChannelId,
        thread_ts: assistantThreadTs,
        text: newStyle ? 'Style saved for this thread.' : 'Style cleared.',
        blocks: buildStyleConfirmationBlocks(newStyle),
      });
    } catch (error) {
      logger.error('Failed to post style confirmation:', error);
    }

    logger.info(`Style ${newStyle ? 'set' : 'cleared'} for thread ${assistantChannelId}:${assistantThreadTs}`);
  });
}
