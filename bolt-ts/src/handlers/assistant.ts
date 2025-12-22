/**
 * Assistant middleware using Bolt.js Assistant class.
 *
 * This module uses the recommended Bolt.js Assistant class pattern which provides
 * built-in utilities like setSuggestedPrompts, setTitle, setStatus, and say.
 * This ensures proper API call handling compared to raw event handlers.
 *
 * Handles:
 * - assistant_thread_started
 * - assistant_thread_context_changed
 * - message.im (user messages in assistant threads)
 */

import { App, Assistant } from '@slack/bolt';
import { v4 as uuidv4 } from 'uuid';
import { buildWelcomeBlocks, buildHelpBlocks, buildStyleConfirmationBlocks } from '../blocks';
import { parseUserIntent } from '../intent';
import { buildSummarizeLoadingMessages } from '../loading_messages';
import { sendToSqs } from '../sqs';
import type { ThreadContext, ProcessingTask } from '../types';
import {
  buildThreadStateMetadata,
  findThreadStateMessage,
  getCachedThreadState,
  makeThreadKey,
  setCachedThreadState,
  type SlackWebApiClient,
} from '../thread_state';
import type { AppConfig } from '../config';

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
      "summarize with style: find contradictions, broken promises, and things people said they would do but didn't. bring the receipts.",
  },
];

const WELCOME_TEXT = 'Welcome to TLDR';

/**
 * Create the Assistant instance with all handlers.
 *
 * @param config - Application configuration
 * @returns Configured Assistant instance
 */
export function createAssistant(config: AppConfig): Assistant {
  return new Assistant({
    threadStarted: async ({
      event,
      logger,
      say,
      setSuggestedPrompts,
      setTitle,
      saveThreadContext,
    }): Promise<void> => {
      const assistantThread = event.assistant_thread;

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
        // Set suggested prompts using the built-in utility
        // This handles channel_id and thread_ts automatically
        await setSuggestedPrompts({
          prompts: DEFAULT_PROMPTS,
        });
        logger.info(`Set suggested prompts for thread ${channelId}:${threadTs}`);

        // Set thread title
        await setTitle('TLDR');

        // Save thread context for later retrieval
        await saveThreadContext();

        // Post welcome message with channel context
        const welcome = await say({
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
    },

    threadContextChanged: async ({ event, client, logger, saveThreadContext }): Promise<void> => {
      const assistantThread = event.assistant_thread;

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

      // Save context using Assistant's built-in context store
      await saveThreadContext();

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
    },

    userMessage: async ({ client, message, logger, setStatus }): Promise<void> => {
      // Type assertion for message - the Assistant middleware ensures this is a user message
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = message as any;

      // Ignore bot messages and edited/system messages to avoid loops
      if (msg.bot_id || msg.subtype) {
        return;
      }

      const channelId = msg.channel as string | undefined;
      const threadTs = (msg.thread_ts ?? msg.ts) as string | undefined;
      const text = (msg.text as string) || '';
      const userId = msg.user as string | undefined;

      if (!channelId || !userId || !threadTs) {
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
                  blocks: buildWelcomeBlocks(nextState.viewingChannelId, nextState.customStyle),
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
                  blocks: buildWelcomeBlocks(nextState.viewingChannelId, nextState.customStyle),
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
                  blocks: buildWelcomeBlocks(nextState.viewingChannelId, null),
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
                  blocks: buildWelcomeBlocks(nextState.viewingChannelId, null),
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

            // Set status using the built-in utility
            await setStatus({
              status: 'Summarizing...',
              loading_messages: buildSummarizeLoadingMessages({
                messageCount: intent.count ?? 50,
                hasCustomStyle: effectiveStyle !== null && effectiveStyle.trim().length > 0,
              }),
            });

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
    },
  });
}

/**
 * Register the Assistant middleware with the Bolt app.
 *
 * @param app - The Bolt app instance
 * @param config - Application configuration
 */
export function registerAssistantHandlers(app: App, config: AppConfig): void {
  const assistant = createAssistant(config);
  app.assistant(assistant);
}
