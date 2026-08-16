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
  buildWelcomeBlocks,
} from '../blocks';
import { parseUserIntent } from '../intent';
import { normalizeMessageCount, validateAndSanitizeStyle } from '../security';
import type { ThreadContext, UserIntent } from '../types';
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
import { runGeneralChat } from '../worker/chat';
import { guardAndRunSummarization } from './run_summary';

const WELCOME_TEXT = 'Welcome to TLDR';

/**
 * Instant reply for a file shared with no caption. Posted directly — no
 * model call, no rate-limit slot: the answer is always the same sentence,
 * so the user shouldn't wait several seconds (or spend budget) for it.
 */
export const FILE_SHARE_NO_CAPTION_REPLY =
  "🖼️ I can't open files or attachments — chat here is text-only. Add a caption with your question, or paste the text you'd like me to look at.";

/**
 * Appended to a file-share caption so the model knows an attachment exists
 * that it cannot see. Pairs with the text-only rule in CHAT_SYSTEM_PROMPT.
 */
export const FILE_ATTACHMENT_NOTE =
  '(note: the user also attached a file — you cannot see attachments)';

/**
 * Bolt's Assistant middleware only forwards IM thread messages with no
 * subtype or `subtype === 'file_share'`. Bot messages and every other
 * subtype (edits, deletes, channel_join, …) must stay ignored so we
 * don't loop. File shares are real user turns — dropping them leaves
 * the Slack desktop pane on read. (Rare user-producible subtypes —
 * `me_message`, `thread_broadcast` — never reach this handler at all;
 * Bolt drops them upstream, so they go unanswered. Known edge.)
 */
export function shouldIgnoreAssistantUserMessage(msg: {
  bot_id?: string;
  subtype?: string;
}): boolean {
  if (msg.bot_id) {
    return true;
  }
  return Boolean(msg.subtype) && msg.subtype !== 'file_share';
}

/** How an assistant-pane user message gets handled. */
export type AssistantRoute =
  | { kind: 'file_share_no_caption' }
  | { kind: 'chat'; userText: string }
  | { kind: 'command'; intent: UserIntent };

/**
 * File shares never go through the command parser: a caption like `tldr`
 * or `summarize` almost certainly refers to the attachment — which chat
 * cannot read — so running a channel summary would confidently answer the
 * wrong question. Captions go to chat with an attachment note instead.
 */
export function routeAssistantUserMessage(msg: {
  text?: string;
  subtype?: string;
}): AssistantRoute {
  const text = (msg.text ?? '').trim();
  if (msg.subtype === 'file_share') {
    if (text.length === 0) {
      return { kind: 'file_share_no_caption' };
    }
    return { kind: 'chat', userText: `${text}\n${FILE_ATTACHMENT_NOTE}` };
  }
  const intent = parseUserIntent(text);
  if (intent.type === 'unknown') {
    return { kind: 'chat', userText: text };
  }
  return { kind: 'command', intent };
}

const CHANNEL_PROMPTS: Array<{ title: string; message: string }> = [
  { title: '📋 Just the Facts', message: 'summarize' },
  {
    title: '🔥 Choose Violence',
    message:
      'summarize with style: maximum chaos mode — be theatrically funny, dramatic, and roast everyone with surgical precision. make it actually funny, not just mean. start every bullet with a verdict emoji: 🔥 hot take, 💀 self-own, 🤡 clown moment, 📉 L taken, 🎯 surprisingly valid, 🚨 red flag, 🍿 drama unfolding, 🧠 galaxy brain, ⚰️ buried by their own argument. in the Summary section, tag each named person with one verdict emoji after their name. end the Summary with a one-line "🏆 MVP: <person>" and "🪦 casualty: <person>" awards. mock-outrage, dramatic gasps, and absurdist commentary encouraged. keep all four sections, real links, and real receipts intact.',
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

    // NOTE: we never call Bolt's saveThreadContext() here (or in
    // threadStarted). Nothing in this app reads Bolt's context store, and
    // its default implementation chat.update's the first bot message in the
    // thread — our welcome card — replacing the `tldr_thread_state` metadata
    // that cold starts depend on. The welcome card is the single source of
    // truth for thread state; skipping the store also saves two Slack
    // round-trips on every channel switch.
    threadContextChanged: async ({ event, client, logger }): Promise<void> => {
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

      // Await both writes: this Lambda is async, so fire-and-forget `void`
      // calls can be dropped when the handler returns and the container
      // freezes. The welcome card is the only store
      // `loadThreadStateWithFallback` reads on a cold start. The two calls
      // are independent, so they run concurrently — the suggested-prompt
      // chips shouldn't queue behind the metadata write.
      const stateMessageTs = cached?.state_message_ts;
      const persistState = async (): Promise<void> => {
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
        } else {
          try {
            await client.chat.update({
              channel: channelId,
              ts: stateMessageTs,
              text: WELCOME_TEXT,
              blocks: buildWelcomeBlocks(
                nextState.viewingChannelId,
                nextState.customStyle,
                nextState.defaultMessageCount
              ),
              metadata: buildThreadStateMetadata(nextState),
            });
            setCachedThreadState({ threadKey, stateMessageTs, state: nextState });
            logger.info(`Context changed: viewing_channel_id=${viewingChannelId}`);
          } catch (err) {
            logger.error('Failed to persist thread context:', err);
          }
        }
      };

      // A channel is in view now — swap any onboarding prompts for the real ones.
      const refreshPrompts = async (): Promise<void> => {
        const prompts = buildThreadStartPrompts(viewingChannelId);
        try {
          await client.assistant.threads.setSuggestedPrompts({
            channel_id: channelId,
            thread_ts: threadTs,
            title: 'Pick your poison:',
            prompts: prompts as [(typeof prompts)[number], ...typeof prompts],
          });
        } catch (err) {
          logger.warn('Failed to refresh suggested prompts:', err);
        }
      };

      await Promise.all([persistState(), refreshPrompts()]);
    },

    userMessage: async ({ client, message, logger }): Promise<void> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = message as any;

      if (shouldIgnoreAssistantUserMessage(msg)) {
        return;
      }

      const channelId = msg.channel as string | undefined;
      const threadTs = (msg.thread_ts ?? msg.ts) as string | undefined;
      const userId = msg.user as string | undefined;

      if (!channelId || !userId || !threadTs) {
        return;
      }

      const route = routeAssistantUserMessage(msg);

      if (route.kind === 'file_share_no_caption') {
        try {
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: FILE_SHARE_NO_CAPTION_REPLY,
          });
        } catch (error) {
          logger.error('Failed to answer captionless file share:', error);
        }
        return;
      }

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
        if (route.kind === 'chat') {
          // Not a command — let the model answer. The chat worker retries a
          // failed stream before showing a failure nudge.
          const state = await loadThreadStateWithFallback({
            client: client as unknown as SlackWebApiClient,
            assistantChannelId: channelId,
            assistantThreadTs: threadTs,
            logger,
          });
          await runGeneralChat({
            client,
            config,
            userId,
            surface: 'assistant',
            channelId,
            threadTs,
            userText: route.userText,
            userMessageTs: msg.ts as string,
            viewingChannelId: state.viewingChannelId,
            logger,
          });
          return;
        }

        const intent = route.intent;
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

          // 'unknown' is routed to chat above and never reaches this switch.
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
