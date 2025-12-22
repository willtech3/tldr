/**
 * Assistant thread event handlers.
 *
 * Handles Slack AI App assistant events:
 * - assistant_thread_started
 * - assistant_thread_context_changed
 */

import { App } from '@slack/bolt';
import { buildWelcomeBlocks } from '../blocks';
import type { ThreadContext } from '../types';
import {
  buildThreadStateMetadata,
  findThreadStateMessage,
  getCachedThreadState,
  makeThreadKey,
  setCachedThreadState,
  type SlackWebApiClient,
} from '../thread_state';

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
 *
 * These prompts are optimized for the friend group use case:
 * - Roasting and sarcasm are central
 * - "Receipts" (calling out contradictions) are valuable
 * - Entertainment and engagement matter more than corporate utility
 *
 * Note: "Set style" is handled via the button in the welcome message, not as a
 * suggested prompt, to avoid sending a message the bot can't respond to.
 */
const DEFAULT_PROMPTS: Array<{ title: string; message: string }> = [
  {
    title: '🔥 Choose Violence',
    message:
      'summarize with style: be hyper-critical, sarcastic, and roast everyone mercilessly. call out bad takes and dumb ideas.',
  },
  {
    title: '📋 Just the Facts',
    message: 'summarize',
  },
  {
    title: '🕵️ Run the Investigation',
    message:
      'summarize with style: break down by person. what did each person contribute? be specific about who said what.',
  },
  {
    title: '📜 Pull the Receipts',
    message:
      'summarize with style: find contradictions, broken promises, and things people said they would do but didn\'t. bring the receipts.',
  },
];

const WELCOME_TEXT = 'Welcome to TLDR';

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

    const initialState: ThreadContext = {
      viewingChannelId: assistantThread.context?.channel_id ?? null,
      customStyle: null,
    };

    try {
      // Set suggested prompts (fire and forget - don't block ACK)
      client.assistant.threads
        .setSuggestedPrompts({
          channel_id: channelId,
          thread_ts: threadTs,
          prompts: DEFAULT_PROMPTS.map((p) => ({ title: p.title, message: p.message })),
        })
        .catch((err) => logger.error('Failed to set suggested prompts:', err));

      // Set thread title (fire and forget)
      client.assistant.threads
        .setTitle({
          channel_id: channelId,
          thread_ts: threadTs,
          title: 'TLDR',
        })
        .catch((err) => logger.error('Failed to set thread title:', err));

      // Post welcome message with channel context
      const welcome = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: WELCOME_TEXT,
        blocks: buildWelcomeBlocks(initialState.viewingChannelId, initialState.customStyle),
        metadata: buildThreadStateMetadata(initialState),
      });

      if (welcome.ts) {
        setCachedThreadState({
          threadKey: makeThreadKey(channelId, threadTs),
          stateMessageTs: welcome.ts,
          state: initialState,
        });
      }

      logger.info(`Assistant thread started in ${channelId}`);
    } catch (error) {
      logger.error('Error handling assistant_thread_started:', error);
    }
  });

  // Handle context changes (user navigating to different channels)
  app.event('assistant_thread_context_changed', async ({ event, client, logger }) => {
    // Extract assistant_thread from the event
    const assistantThread = (event as { assistant_thread?: AssistantThread }).assistant_thread;

    if (!assistantThread) {
      logger.warn('assistant_thread_context_changed missing assistant_thread');
      return;
    }

    const channelId = assistantThread.channel_id;
    const threadTs = assistantThread.thread_ts;
    const viewingChannelId = assistantThread.context?.channel_id ?? null;

    if (!channelId || !threadTs) {
      logger.warn('assistant_thread_context_changed missing channel_id or thread_ts');
      return;
    }

    if (!viewingChannelId) {
      logger.info('assistant_thread_context_changed: no viewing channel provided');
      return;
    }

    const threadKey = makeThreadKey(channelId, threadTs);

    let cached = getCachedThreadState(threadKey);
    if (!cached) {
      try {
        cached = await findThreadStateMessage({
          client: client as unknown as SlackWebApiClient,
          assistantChannelId: channelId,
          assistantThreadTs: threadTs,
        });
      } catch (error) {
        logger.warn('Failed to load existing thread state message:', error);
      }
    }

    const nextState: ThreadContext = {
      viewingChannelId,
      customStyle: cached?.state.customStyle ?? null,
    };

    const stateMessageTs = cached?.state_message_ts;
    if (!stateMessageTs) {
      // We should have created a state/welcome message on thread start, but if we
      // didn't (cold start, Slack retry, etc.), create it now so context is still persisted.
      try {
        const welcome = await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: WELCOME_TEXT,
          blocks: buildWelcomeBlocks(nextState.viewingChannelId, nextState.customStyle),
          metadata: buildThreadStateMetadata(nextState),
        });
        if (welcome.ts) {
          setCachedThreadState({ threadKey, stateMessageTs: welcome.ts, state: nextState });
        }
      } catch (error) {
        logger.error('Failed to create thread state message:', error);
      }
      return;
    }

    // Persist context into Slack thread state message metadata.
    // Update the welcome message to reflect the new viewing channel.
    void client.chat
      .update({
        channel: channelId,
        ts: stateMessageTs,
        text: WELCOME_TEXT,
        blocks: buildWelcomeBlocks(nextState.viewingChannelId, nextState.customStyle),
        metadata: buildThreadStateMetadata(nextState),
      })
      .then(() => {
        setCachedThreadState({ threadKey, stateMessageTs, state: nextState });
        logger.info(`Context changed: viewing_channel_id=${viewingChannelId}`);
      })
      .catch((err) => logger.error('Failed to persist thread context:', err));
  });
}
