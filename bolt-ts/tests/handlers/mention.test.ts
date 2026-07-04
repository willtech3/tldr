import type { WebClient } from '@slack/web-api';
import {
  EMPTY_MENTION_TEXT,
  handleAppMention,
  stripBotMention,
} from '../../src/handlers/mention';
import type { AppConfig } from '../../src/config';

const config = {
  slackBotToken: 'xoxb',
  slackSigningSecret: 'sig',
  anthropicApiKey: 'sk-ant',
  anthropicModel: 'claude-test',
  anthropicMaxOutputTokens: 4096,
  enableStreaming: true,
  streamMaxChunkChars: 4000,
  streamMinAppendIntervalMs: 0,
} as AppConfig;

const client = {} as WebClient;
const logger = { warn: jest.fn(), error: jest.fn() };

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'C42',
    ts: '11.0',
    text: '<@UBOT> what do you think?',
    user: 'U1',
    team: 'T1',
    ...overrides,
  };
}

function callArgs(event: Record<string, unknown>, chat: jest.Mock) {
  return {
    event: event as never,
    client,
    config,
    botUserId: 'UBOT',
    teamId: 'TCTX',
    logger,
    chat: chat as never,
  };
}

describe('stripBotMention', () => {
  it('removes the bot mention wherever it appears and tidies whitespace', () => {
    expect(stripBotMention('<@UBOT> what do you think?', 'UBOT')).toBe('what do you think?');
    expect(stripBotMention('hey <@UBOT>, thoughts? <@UBOT>', 'UBOT')).toBe('hey , thoughts?');
  });

  it('keeps other people’s mentions', () => {
    expect(stripBotMention('<@UBOT> ask <@UOTHER>', 'UBOT')).toBe('ask <@UOTHER>');
  });

  it('leaves text alone when the bot user id is unknown', () => {
    expect(stripBotMention(' <@UBOT> hi ', null)).toBe('<@UBOT> hi');
  });
});

describe('handleAppMention', () => {
  it('answers a mention as channel-surface chat in the message thread', async () => {
    const chat = jest.fn().mockResolvedValue('delivered');

    await handleAppMention(callArgs(makeEvent(), chat));

    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'channel',
        channelId: 'C42',
        threadTs: '11.0',
        userId: 'U1',
        userText: 'what do you think?',
        userMessageTs: '11.0',
        recipientTeamId: 'T1',
      })
    );
  });

  it('replies inside the existing thread when the mention is a threaded reply', async () => {
    const chat = jest.fn().mockResolvedValue('delivered');

    await handleAppMention(callArgs(makeEvent({ thread_ts: '5.0' }), chat));

    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({ threadTs: '5.0', userMessageTs: '11.0' })
    );
  });

  it('falls back to the context team id when the event has none', async () => {
    const chat = jest.fn().mockResolvedValue('delivered');

    await handleAppMention(callArgs(makeEvent({ team: undefined }), chat));

    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ recipientTeamId: 'TCTX' }));
  });

  it('substitutes a placeholder when the mention has no other text', async () => {
    const chat = jest.fn().mockResolvedValue('delivered');

    await handleAppMention(callArgs(makeEvent({ text: '<@UBOT>' }), chat));

    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ userText: EMPTY_MENTION_TEXT }));
  });

  it.each([
    ['bot messages', { bot_id: 'B99' }],
    ['message edits', { subtype: 'message_changed' }],
    ['events without a user', { user: undefined }],
  ])('ignores %s', async (_name, overrides) => {
    const chat = jest.fn();

    await handleAppMention(callArgs(makeEvent(overrides), chat));

    expect(chat).not.toHaveBeenCalled();
  });
});
