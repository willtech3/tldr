/**
 * Tests for the "Summarize Thread" message shortcut pipeline.
 */

import type { WebClient } from '@slack/web-api';
import { LlmClient } from '../../src/ai/anthropic';
import type { AppConfig } from '../../src/config';
import { runThreadSummarization } from '../../src/handlers/shortcuts';
import { resetRateLimitForTests } from '../../src/security';

function makeConfig(): AppConfig {
  return {
    slackBotToken: 'xoxb',
    slackSigningSecret: 'sig',
    anthropicApiKey: 'sk-ant',
    anthropicModel: 'claude-test',
    anthropicMaxOutputTokens: 4096,
    enableStreaming: true,
    streamMaxChunkChars: 4000,
    streamMinAppendIntervalMs: 0,
  };
}

function makeClient(replies: unknown[]): WebClient {
  return {
    conversations: {
      replies: jest.fn().mockResolvedValue({ messages: replies }),
      info: jest.fn().mockResolvedValue({ channel: { name: 'demo' } }),
    },
    users: { info: jest.fn().mockResolvedValue({ user: { profile: { real_name: 'Alice' } } }) },
    auth: { test: jest.fn().mockResolvedValue({ user_id: 'UBOT' }) },
    chat: { getPermalink: jest.fn().mockResolvedValue({ permalink: 'https://slack/p/1' }) },
  } as unknown as WebClient;
}

describe('runThreadSummarization', () => {
  afterEach(() => resetRateLimitForTests());

  it('responds ephemerally with a markdown summary of the thread', async () => {
    const respond = jest.fn().mockResolvedValue(undefined);
    const llm = new LlmClient({ apiKey: 'sk-ant', model: 'claude-test' });
    jest.spyOn(llm, 'generateSummary').mockResolvedValue('**Summary**\nstuff happened');

    await runThreadSummarization({
      config: makeConfig(),
      client: makeClient([
        { ts: '1.0', user: 'U1', text: 'parent message', files: [] },
        { ts: '1.1', user: 'U2', text: 'a reply', files: [] },
      ]),
      payload: { userId: 'U9', channelId: 'C123456789', threadTs: '1.0' },
      respond,
      llm,
      logger: { error: jest.fn() },
    });

    expect(respond).toHaveBeenCalledTimes(1);
    const message = respond.mock.calls[0][0];
    const markdown = message.blocks.find((b: { type: string }) => b.type === 'markdown');
    expect(markdown.text).toContain('**TLDR of this thread**');
    expect(markdown.text).toContain('stuff happened');
    const context = message.blocks.find((b: { type: string }) => b.type === 'context');
    expect(context.elements[0].text).toContain('only visible to you');
  });

  it('replies with a friendly message when the thread is empty after bot filtering', async () => {
    const respond = jest.fn().mockResolvedValue(undefined);
    const llm = new LlmClient({ apiKey: 'sk-ant', model: 'claude-test' });
    const generate = jest.spyOn(llm, 'generateSummary');

    await runThreadSummarization({
      config: makeConfig(),
      client: makeClient([{ ts: '1.0', user: 'UBOT', text: 'bot noise', files: [] }]),
      payload: { userId: 'U9', channelId: 'C123456789', threadTs: '1.0' },
      respond,
      llm,
      logger: { error: jest.fn() },
    });

    expect(generate).not.toHaveBeenCalled();
    expect(respond.mock.calls[0][0].text).toContain('nothing in this thread');
  });

  it('tells the user to invite the bot when it cannot read the channel', async () => {
    const respond = jest.fn().mockResolvedValue(undefined);
    const client = makeClient([]);
    (client.conversations.replies as jest.Mock).mockRejectedValue({
      data: { error: 'not_in_channel' },
    });

    await runThreadSummarization({
      config: makeConfig(),
      client,
      payload: { userId: 'U9', channelId: 'C123456789', threadTs: '1.0' },
      respond,
      llm: new LlmClient({ apiKey: 'sk-ant', model: 'claude-test' }),
      logger: { error: jest.fn() },
    });

    expect(respond.mock.calls[0][0].text).toContain('/invite @TLDR');
  });
});
