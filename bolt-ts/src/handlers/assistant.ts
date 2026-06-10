/**
 * Assistant middleware using Bolt.js Assistant class.
 *
 * Handles:
 *  - assistant_thread_started: greet the user, set suggested prompts, persist
 *    initial thread state.
 *  - assistant_thread_context_changed: update the cached viewing channel.
 *  - message.im: parse user intent and run help/style/clear-style/summarize
 *    flows. Summarisation runs inline (no SQS) and streams the response back
 *    into the assistant thread.
 */

import { App, Assistant } from '@slack/bolt';
import {
  buildHelpBlocks,
  buildStyleConfirmationBlocks,
  buildUnknownIntentBlocks,
  buildWelcomeBlocks,
} from '../blocks';
import { parseUserIntent } from '../intent';
import { normalizeMessageCount, validateAndSanitizeStyle } from '../security';
import type { ThreadContext } from '../types';
import {
  buildThreadStateMetadata,
  findThreadStateMessage,
  getCachedThreadState,
  loadThreadStateWithFallback,
  makeThreadKey,
  setCachedThreadState,
  type SlackWebApiClient,
} from '../thread_state';
import type { AppConfig } from '../config';
import { guardAndRunSummarization } from './run_summary';

const WELCOME_TEXT = 'Welcome to TLDR';

const CHANNEL_PROMPTS: Array<{ title: string; message: string }> = [
  { title: '📋 Just the Facts', message: 'summarize' },
  {
    title: '🔥 Choose Violence',
    message:
      'summarize with style: be hyper-critical, sarcastic, and roast everyone mercilessly. call out bad takes and dumb ideas.',
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

const ONBOARDING_PROMPTS: Array<{ title: string; message: string }> = [
  { title: '📖 Show me what you can do', message: 'help' },
  { title: '⚡ Summarize my current channel', message: 'summarize' },
];

/**
 * Suggested prompts for a fresh thread. Without a channel in view, every
 * one-tap summarize would fail — offer onboarding prompts instead.
 */
export function buildThreadStartPrompts(
  viewingChannelId: string | null
): Array<{ title: string; message: string }> {
  return viewingChannelId ? CHANNEL_PROMPTS : ONBOARDING_PROMPTS;
}

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
        defaultMessageCount: null,
      };

      try {
        const prompts = buildThreadStartPrompts(initialState.viewingChannelId);
        await setSuggestedPrompts({
          title: initialState.viewingChannelId ? 'Pick your poison:' : 'New here? Start with:',
          prompts: prompts as [(typeof prompts)[number], ...typeof prompts],
        });
        await setTitle('TLDR');
        await saveThreadContext();

        const welcome = await say({
          text: WELCOME_TEXT,
          blocks: buildWelcomeBlocks(
            initialState.viewingChannelId,
            initialState.customStyle,
            initialState.defaultMessageCount
          ),
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
        return;
      }
      const channelId = assistantThread.channel_id;
      const threadTs = assistantThread.thread_ts;
      const viewingChannelId = assistantThread.context?.channel_id ?? null;
      if (!channelId || !threadTs || !viewingChannelId) {
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
        defaultMessageCount: cached?.state.defaultMessageCount ?? null,
      };

      await saveThreadContext();

      const stateMessageTs = cached?.state_message_ts;
      if (!stateMessageTs) {
        try {
          const welcome = await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: WELCOME_TEXT,
            blocks: buildWelcomeBlocks(
              nextState.viewingChannelId,
              nextState.customStyle,
              nextState.defaultMessageCount
            ),
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

      void client.chat
        .update({
          channel: channelId,
          ts: stateMessageTs,
          text: WELCOME_TEXT,
          blocks: buildWelcomeBlocks(
            nextState.viewingChannelId,
            nextState.customStyle,
            nextState.defaultMessageCount
          ),
          metadata: buildThreadStateMetadata(nextState),
        })
        .then(() => {
          setCachedThreadState({ threadKey, stateMessageTs, state: nextState });
          logger.info(`Context changed: viewing_channel_id=${viewingChannelId}`);
        })
        .catch((err) => logger.error('Failed to persist thread context:', err));

      // A channel is in view now — swap any onboarding prompts for the real ones.
      const prompts = buildThreadStartPrompts(viewingChannelId);
      void client.assistant.threads
        .setSuggestedPrompts({
          channel_id: channelId,
          thread_ts: threadTs,
          title: 'Pick your poison:',
          prompts: prompts as [(typeof prompts)[number], ...typeof prompts],
        })
        .catch((err) => logger.warn('Failed to refresh suggested prompts:', err));
    },

    userMessage: async ({ client, message, logger }): Promise<void> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = message as any;

      // Ignore bot messages and edited/system messages to avoid loops.
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

      const getCachedOrEmpty = (): {
        state: ThreadContext;
        stateMessageTs: string | null;
      } => {
        const cached = getCachedThreadState(threadKey);
        if (cached) {
          return { state: cached.state, stateMessageTs: cached.state_message_ts };
        }
        return {
          state: { viewingChannelId: null, customStyle: null, defaultMessageCount: null },
          stateMessageTs: null,
        };
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

          case 'style':
          case 'clear_style': {
            const sanitizedStyle =
              intent.type === 'style'
                ? validateAndSanitizeStyle(intent.instructions)
                : { ok: true as const, value: null };
            if (!sanitizedStyle.ok) {
              await client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: sanitizedStyle.reason,
              });
              return;
            }

            let { state, stateMessageTs } = getCachedOrEmpty();
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
              customStyle: sanitizedStyle.value,
              defaultMessageCount: state.defaultMessageCount,
            };

            await persistThreadState({
              client,
              channelId,
              threadTs,
              stateMessageTs,
              state: nextState,
              logger,
            });

            await client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: nextState.customStyle ? 'Style saved for this thread.' : 'Style cleared.',
              blocks: buildStyleConfirmationBlocks(nextState.customStyle),
            });
            break;
          }

          case 'summarize': {
            // Survive cold starts: fall back to the Slack-metadata state
            // message so the channel/style/count the welcome card shows are
            // actually honored.
            const state = await loadThreadStateWithFallback({
              client: client as unknown as SlackWebApiClient,
              assistantChannelId: channelId,
              assistantThreadTs: threadTs,
              logger,
            });
            const targetChannelId = intent.targetChannel ?? state.viewingChannelId;

            if (!targetChannelId) {
              await client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text:
                  "I don't know which channel you're viewing yet. Switch to a channel in Slack, then try `summarize` again — or mention one like `summarize #general`.",
              });
              return;
            }

            const effectiveStyleRaw = intent.styleOverride ?? state.customStyle;
            const sanitizedStyle = validateAndSanitizeStyle(effectiveStyleRaw);
            if (!sanitizedStyle.ok) {
              await client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: sanitizedStyle.reason,
              });
              return;
            }

            await guardAndRunSummarization({
              client,
              config,
              userId,
              sourceChannelId: targetChannelId,
              assistantChannelId: channelId,
              assistantThreadTs: threadTs,
              messageCount: normalizeMessageCount(
                intent.count,
                normalizeMessageCount(state.defaultMessageCount)
              ),
              customStyle: sanitizedStyle.value,
              logger,
            });
            break;
          }

          case 'unknown':
          default: {
            // Never leave the user on read — nudge them toward a next step.
            const state = await loadThreadStateWithFallback({
              client: client as unknown as SlackWebApiClient,
              assistantChannelId: channelId,
              assistantThreadTs: threadTs,
              logger,
            });
            await client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: "I didn't catch that. Try `summarize`, or tap a button below.",
              blocks: buildUnknownIntentBlocks(state.viewingChannelId),
            });
            break;
          }
        }
      } catch (error) {
        logger.error('Error handling message:', error);
      }
    },
  });
}

interface PersistStateArgs {
  client: unknown;
  channelId: string;
  threadTs: string;
  stateMessageTs: string | null;
  state: ThreadContext;
  logger: { error(message: string, err?: unknown): void };
}

async function persistThreadState(args: PersistStateArgs): Promise<void> {
  const { channelId, threadTs, stateMessageTs, state, logger } = args;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = args.client as any;
  const threadKey = makeThreadKey(channelId, threadTs);
  if (stateMessageTs) {
    try {
      await client.chat.update({
        channel: channelId,
        ts: stateMessageTs,
        text: WELCOME_TEXT,
        blocks: buildWelcomeBlocks(
          state.viewingChannelId,
          state.customStyle,
          state.defaultMessageCount
        ),
        metadata: buildThreadStateMetadata(state),
      });
      setCachedThreadState({ threadKey, stateMessageTs, state });
    } catch (error) {
      logger.error('Failed to update thread state message', error);
    }
    return;
  }
  try {
    const resp = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: WELCOME_TEXT,
      blocks: buildWelcomeBlocks(
        state.viewingChannelId,
        state.customStyle,
        state.defaultMessageCount
      ),
      metadata: buildThreadStateMetadata(state),
    });
    if (resp.ts) {
      setCachedThreadState({ threadKey, stateMessageTs: resp.ts, state });
    }
  } catch (error) {
    logger.error('Failed to create thread state message', error);
  }
}

export function registerAssistantHandlers(app: App, config: AppConfig): void {
  const assistant = createAssistant(config);
  app.assistant(assistant);
}
