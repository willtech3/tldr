/**
 * Message event handlers.
 *
 * Handles message events in assistant threads (message.im).
 *
 * Context tracking comes from `assistant_thread_context_changed` and is persisted
 * into Slack message metadata for this assistant thread.
 */

import { App } from '@slack/bolt';
import { v4 as uuidv4 } from 'uuid';
import { parseUserIntent } from '../intent';
import { buildHelpBlocks, buildWelcomeBlocks, buildStyleConfirmationBlocks } from '../blocks';
import { sendToSqs } from '../sqs';
import { ProcessingTask } from '../types';
import { AppConfig } from '../config';
import type { ThreadContext } from '../types';
import {
  buildThreadStateMetadata,
  findThreadStateMessage,
  getCachedThreadState,
  makeThreadKey,
  setCachedThreadState,
  type SlackWebApiClient,
} from '../thread_state';

const WELCOME_TEXT = 'Welcome to TLDR';

// Basic message event type for our use case
interface MessageEvent {
  type: string;
  channel: string;
  channel_type?: string;
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

    // We only support AI App assistant threads (IM).
    if (msg.channel_type && msg.channel_type !== 'im') {
      return;
    }

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
    const threadKey = makeThreadKey(channelId, threadTs);

    // IMPORTANT: Avoid Slack Web API calls in this hot path to minimize risk of
    // breaching Slack's 3s ACK window. The assistant thread events
    // (`assistant_thread_started` / `assistant_thread_context_changed`) populate this
    // cache on warm containers; on cold starts we fall back to best-effort behavior.
    const getThreadStateFromCache = (): {
      state: ThreadContext;
      stateMessageTs: string | null;
    } => {
      const cached = getCachedThreadState(threadKey);
      if (cached) {
        return { state: cached.state, stateMessageTs: cached.state_message_ts };
      }

      return { state: { viewingChannelId: null, customStyle: null }, stateMessageTs: null };
    };

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

        case 'style': {
          let { state, stateMessageTs } = getThreadStateFromCache();

          // On cache miss, load state from Slack metadata to avoid creating duplicates
          if (!stateMessageTs) {
            try {
              const loaded = await findThreadStateMessage({
                client: client as unknown as SlackWebApiClient,
                assistantChannelId: channelId,
                assistantThreadTs: threadTs,
              });
              if (loaded) {
                state = loaded.state;
                stateMessageTs = loaded.state_message_ts;
              }
            } catch (error) {
              logger.warn('Failed to load thread state from Slack:', error);
            }
          }

          const nextState: ThreadContext = {
            viewingChannelId: state.viewingChannelId,
            customStyle: intent.instructions,
          };

          if (stateMessageTs) {
            void client.chat
              .update({
                channel: channelId,
                ts: stateMessageTs,
                text: WELCOME_TEXT,
                blocks: buildWelcomeBlocks(nextState.customStyle),
                metadata: buildThreadStateMetadata(nextState),
              })
              .then(() => {
                setCachedThreadState({ threadKey, stateMessageTs, state: nextState });
              })
              .catch((err) => logger.error('Failed to persist style to thread state:', err));
          } else {
            // If no state message exists (truly missing), persist state on a new message.
            try {
              const resp = await client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: WELCOME_TEXT,
                blocks: buildWelcomeBlocks(nextState.customStyle),
                metadata: buildThreadStateMetadata(nextState),
              });
              if (resp.ts) {
                setCachedThreadState({ threadKey, stateMessageTs: resp.ts, state: nextState });
              }
            } catch (error) {
              logger.error('Failed to create thread state message for style:', error);
              await client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: "Sorry, I couldn't generate a summary at this time. Please try again later.",
              });
              return;
            }
          }

          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: 'Style saved for this thread.',
            blocks: buildStyleConfirmationBlocks(intent.instructions),
          });
          break;
        }

        case 'clear_style': {
          let { state, stateMessageTs } = getThreadStateFromCache();

          // On cache miss, load state from Slack metadata to avoid creating duplicates
          if (!stateMessageTs) {
            try {
              const loaded = await findThreadStateMessage({
                client: client as unknown as SlackWebApiClient,
                assistantChannelId: channelId,
                assistantThreadTs: threadTs,
              });
              if (loaded) {
                state = loaded.state;
                stateMessageTs = loaded.state_message_ts;
              }
            } catch (error) {
              logger.warn('Failed to load thread state from Slack:', error);
            }
          }

          const nextState: ThreadContext = {
            viewingChannelId: state.viewingChannelId,
            customStyle: null,
          };

          if (stateMessageTs) {
            void client.chat
              .update({
                channel: channelId,
                ts: stateMessageTs,
                text: WELCOME_TEXT,
                blocks: buildWelcomeBlocks(null),
                metadata: buildThreadStateMetadata(nextState),
              })
              .then(() => {
                setCachedThreadState({ threadKey, stateMessageTs, state: nextState });
              })
              .catch((err) => logger.error('Failed to clear style in thread state:', err));
          } else {
            // If no state message exists (truly missing), create one with cleared style
            try {
              const resp = await client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: WELCOME_TEXT,
                blocks: buildWelcomeBlocks(null),
                metadata: buildThreadStateMetadata(nextState),
              });
              if (resp.ts) {
                setCachedThreadState({ threadKey, stateMessageTs: resp.ts, state: nextState });
              }
            } catch (error) {
              logger.error('Failed to create thread state message for clear style:', error);
            }
          }

          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: 'Style cleared.',
            blocks: buildStyleConfirmationBlocks(null),
          });
          break;
        }

        case 'summarize': {
          const { state } = getThreadStateFromCache();
          const targetChannelId = intent.targetChannel ?? state.viewingChannelId;

          if (!targetChannelId) {
            await client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text:
                "I don't know which channel you're viewing yet. Switch to a channel in Slack, then try `summarize` again — or mention one like `summarize <#C123|general>`.",
            });
            return;
          }

          // Use per-run style override if present, otherwise fall back to thread's customStyle
          const effectiveStyle = intent.styleOverride ?? state.customStyle;

          // Set status after validation so we don't show "Summarizing..." for an immediate error.
          client.assistant.threads
            .setStatus({
              channel_id: channelId,
              thread_ts: threadTs,
              status: 'Summarizing...',
            })
            .catch((err) => logger.error('Failed to set status:', err));

          // Build and enqueue processing task
          const task: ProcessingTask = {
            correlation_id: uuidv4(),
            user_id: userId,
            channel_id: targetChannelId,
            thread_ts: threadTs,
            origin_channel_id: channelId,
            response_url: null,
            text: text.toLowerCase(),
            message_count: intent.count,
            target_channel_id: null,
            custom_prompt: effectiveStyle,
            // AI App UX: always reply in-thread (never post publicly from the worker).
            visible: false,
            destination: 'Thread',
            dest_dm: false,
            dest_public_post: false,
          };

          try {
            await sendToSqs(task, config.processingQueueUrl);

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
