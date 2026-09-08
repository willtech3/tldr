/** Style editor interactions and thread-scoped persistence. */
import { App, BlockAction } from '@slack/bolt';
import type { View } from '@slack/types';
import type { WebClient } from '@slack/web-api';
import {
  ACTION_OPEN_STYLE_MODAL,
  MODAL_CALLBACK_SET_STYLE,
  INPUT_BLOCK_STYLE,
  INPUT_ACTION_STYLE,
  INPUT_BLOCK_STYLE_PRESET,
  INPUT_ACTION_STYLE_PRESET,
  MAX_MODAL_STYLE_LENGTH,
  buildStyleModal,
  buildStyleConfirmationBlocks,
  buildWelcomeBlocks,
  stylePrefillDigest,
  type StyleModalPrivateMetadata,
} from '../blocks';
import {
  buildThreadStateMetadata,
  findThreadStateMessage,
  makeThreadKey,
  parseThreadContextFromMetadata,
  setCachedThreadState,
  TLDR_THREAD_STATE_EVENT_TYPE,
  type SlackWebApiClient,
} from '../thread_state';
import type { ThreadContext } from '../types';
import { DEFAULT_STYLE_PRESET_KEY, STYLE_PRESETS, resolveStylePreset } from '../styles';
import {
  checkChannelMembership,
  isValidSlackChannelId,
  isValidSlackTimestamp,
  validateAndSanitizeStyle,
  type ConversationsMembersClient,
} from '../security';

const WELCOME_TEXT = 'Welcome to TLDR';
const OPEN_FAILURE = 'I couldn’t open style settings. Try again, or type `style: your instructions` here. Use `clear style` to reset.';

interface StyleLogger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
}

/** Log only Slack's error code, not request payloads or credentials. */
function slackErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'unknown';
  }
  const data = 'data' in error ? error.data : null;
  if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') {
    return data.error;
  }
  return 'code' in error && typeof error.code === 'string' ? error.code : 'unknown';
}

async function postStyleNotice(
  client: Pick<WebClient, 'chat'>,
  logger: StyleLogger,
  channel: string,
  threadTs: string,
  text: string
): Promise<void> {
  try {
    await client.chat.postMessage({ channel, thread_ts: threadTs, text });
  } catch (error) {
    logger.error('Failed to post style notice', { code: slackErrorCode(error) });
  }
}

function buildStyleStatusModal(text: string): View {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: 'Set Summary Style' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}

function parseStyleMetadata(raw: string): StyleModalPrivateMetadata | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const metadata = value as Record<string, unknown>;
    if (
      typeof metadata.assistantChannelId !== 'string' ||
      !isValidSlackChannelId(metadata.assistantChannelId) ||
      typeof metadata.assistantThreadTs !== 'string' ||
      !isValidSlackTimestamp(metadata.assistantThreadTs) ||
      (metadata.originalStyleDigest !== undefined &&
        (typeof metadata.originalStyleDigest !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.originalStyleDigest))) ||
      (metadata.hasLongSavedStyle !== undefined && typeof metadata.hasLongSavedStyle !== 'boolean')
    ) {
      return null;
    }
    return {
      assistantChannelId: metadata.assistantChannelId,
      assistantThreadTs: metadata.assistantThreadTs,
      originalStyleDigest: metadata.originalStyleDigest as string | undefined,
      hasLongSavedStyle: metadata.hasLongSavedStyle as boolean | undefined,
    };
  } catch {
    return null;
  }
}

export function registerStyleHandlers(app: App): void {
  app.action<BlockAction>(ACTION_OPEN_STYLE_MODAL, async ({ ack, body, client, logger, respond }) => {
    await ack();
    const message = body.message;
    const channelId = body.channel?.id ?? body.container?.channel_id;
    const threadTs = message?.thread_ts ?? message?.ts;

    if (!isValidSlackChannelId(channelId) || !isValidSlackTimestamp(threadTs)) {
      logger.warn('Could not resolve style action thread');
      try {
        await respond({ text: OPEN_FAILURE, response_type: 'ephemeral', replace_original: false });
      } catch (error) {
        logger.error('Failed to respond to style action', { code: slackErrorCode(error) });
      }
      return;
    }
    if (!body.trigger_id) {
      await postStyleNotice(client, logger, channelId, threadTs, OPEN_FAILURE);
      return;
    }

    const metadata = message?.metadata;
    const state = metadata?.event_type === TLDR_THREAD_STATE_EVENT_TYPE
      ? parseThreadContextFromMetadata(metadata.event_payload)
      : null;
    const privateMetadata = { assistantChannelId: channelId, assistantThreadTs: threadTs };

    // Exchange the short-lived trigger before any history request. The welcome
    // action normally contains the state; older cards get a non-editable loader.
    let opened;
    try {
      opened = await client.views.open({
        trigger_id: body.trigger_id,
        view: state
          ? buildStyleModal(state.customStyle, privateMetadata)
          : buildStyleStatusModal('Loading your saved style…'),
      });
    } catch (error) {
      logger.error('Failed to open style modal', { code: slackErrorCode(error) });
      await postStyleNotice(client, logger, channelId, threadTs, OPEN_FAILURE);
      return;
    }
    if (state) {
      return;
    }
    if (!opened.view?.id) {
      await postStyleNotice(client, logger, channelId, threadTs, OPEN_FAILURE);
      return;
    }
    let loadedView: View;
    try {
      const loaded = await findThreadStateMessage({
        client: client as unknown as SlackWebApiClient,
        assistantChannelId: channelId,
        assistantThreadTs: threadTs,
      });
      loadedView = buildStyleModal(loaded?.state.customStyle ?? null, privateMetadata);
    } catch (error) {
      logger.warn('Failed to load style state', { code: slackErrorCode(error) });
      loadedView = buildStyleStatusModal('I couldn’t load your saved style. Close this window and try again.');
    }
    try {
      await client.views.update({ view_id: opened.view.id, hash: opened.view.hash, view: loadedView });
    } catch (error) {
      logger.error('Failed to update style modal', { code: slackErrorCode(error) });
      await postStyleNotice(client, logger, channelId, threadTs, OPEN_FAILURE);
    }
  });

  app.view(MODAL_CALLBACK_SET_STYLE, async ({ ack, body, view, client, logger }) => {
    const privateMetadata = parseStyleMetadata(view.private_metadata);
    if (!privateMetadata) {
      await ack({ response_action: 'errors', errors: { [INPUT_BLOCK_STYLE]: 'Close this window and reopen style settings.' } });
      logger.warn('Rejected invalid style modal metadata');
      return;
    }

    const { assistantChannelId, assistantThreadTs } = privateMetadata;
    const styleInput = view.state.values[INPUT_BLOCK_STYLE]?.[INPUT_ACTION_STYLE];
    const presetInput = view.state.values[INPUT_BLOCK_STYLE_PRESET]?.[INPUT_ACTION_STYLE_PRESET];
    const freeText = styleInput?.value?.trim() ?? '';
    const presetKey = presetInput?.selected_option?.value ?? null;
    if (presetKey && presetKey !== DEFAULT_STYLE_PRESET_KEY && !STYLE_PRESETS.some((preset) => preset.key === presetKey)) {
      await ack({ response_action: 'errors', errors: { [INPUT_BLOCK_STYLE_PRESET]: 'Choose one of the available presets.' } });
      return;
    }
    if (privateMetadata.hasLongSavedStyle && !freeText && !presetKey) {
      await ack({ response_action: 'errors', errors: { [INPUT_BLOCK_STYLE]: 'Choose a preset or enter a replacement. Cancel keeps your longer saved style.' } });
      return;
    }
    if (freeText.length > MAX_MODAL_STYLE_LENGTH) {
      await ack({ response_action: 'errors', errors: { [INPUT_BLOCK_STYLE]: 'Use up to 3,000 characters here, or up to 4,000 with `style:` in chat.' } });
      return;
    }

    // A new preset beats unchanged prefill. Fresh custom text beats a preset.
    const textIsUntouchedPrefill = freeText.length > 0 &&
      stylePrefillDigest(freeText) === privateMetadata.originalStyleDigest;
    const chosenStyle = freeText && !(presetKey && textIsUntouchedPrefill)
      ? freeText
      : presetKey ? resolveStylePreset(presetKey) : null;
    const styleValidation = validateAndSanitizeStyle(chosenStyle);
    if (!styleValidation.ok) {
      await ack({ response_action: 'errors', errors: { [INPUT_BLOCK_STYLE]: styleValidation.reason } });
      return;
    }
    // Local validation stays inside the modal. Network work follows the ack.
    await ack();
    const membership = await checkChannelMembership({
      client: client as unknown as ConversationsMembersClient,
      channelId: assistantChannelId,
      userId: body.user.id,
      logger,
    });
    if (membership !== 'member') {
      logger.warn('Rejected style save without verified thread membership');
      // Do not post into a destination the requester cannot access.
      try {
        await client.chat.postEphemeral({
          channel: assistantChannelId,
          user: body.user.id,
          text: membership === 'unknown'
            ? 'I couldn’t verify access to this conversation. Your style wasn’t changed; try again.'
            : 'You no longer have access to this conversation. Your style wasn’t changed.',
        });
      } catch (error) {
        logger.error('Failed to report style access error', { code: slackErrorCode(error) });
      }
      return;
    }

    const newStyle = styleValidation.value;
    const threadKey = makeThreadKey(assistantChannelId, assistantThreadTs);
    // Another Lambda may have changed the source or count since the modal
    // opened. Merge with Slack's current state, never a warm-container snapshot.
    let loaded;
    try {
      loaded = await findThreadStateMessage({
        client: client as unknown as SlackWebApiClient,
        assistantChannelId,
        assistantThreadTs,
      });
    } catch (error) {
      logger.warn('Failed to load thread state before style save', { code: slackErrorCode(error) });
      await postStyleNotice(client, logger, assistantChannelId, assistantThreadTs, 'I couldn’t load your settings, so your style wasn’t changed. Try again.');
      return;
    }
    const nextState: ThreadContext = {
      viewingChannelId: null,
      defaultMessageCount: null,
      ...loaded?.state,
      customStyle: newStyle,
    };
    let stateMessageTs = loaded?.state_message_ts;
    const stateMessage = {
      channel: assistantChannelId,
      text: WELCOME_TEXT,
      blocks: buildWelcomeBlocks(nextState.viewingChannelId, newStyle, nextState.defaultMessageCount),
      metadata: buildThreadStateMetadata(nextState),
    };
    try {
      if (stateMessageTs) {
        await client.chat.update({ ...stateMessage, ts: stateMessageTs });
      } else {
        const created = await client.chat.postMessage({ ...stateMessage, thread_ts: assistantThreadTs });
        if (!created.ts) {
          throw new Error('missing_message_timestamp');
        }
        stateMessageTs = created.ts;
      }
      setCachedThreadState({ threadKey, stateMessageTs, state: nextState });
    } catch (error) {
      logger.error('Failed to persist style', { code: slackErrorCode(error) });
      await postStyleNotice(client, logger, assistantChannelId, assistantThreadTs, 'I couldn’t save your style. Try again.');
      return;
    }
    try {
      await client.chat.postMessage({
        channel: assistantChannelId,
        thread_ts: assistantThreadTs,
        text: newStyle ? 'Style saved for this thread.' : 'Default style saved for this thread.',
        blocks: buildStyleConfirmationBlocks(newStyle),
      });
    } catch (error) {
      logger.error('Failed to post style confirmation', { code: slackErrorCode(error) });
    }
    logger.info('Style persisted for assistant thread');
  });
}
