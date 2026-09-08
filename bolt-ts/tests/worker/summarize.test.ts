import type { WebClient } from '@slack/web-api';
import { runSummarization } from '../../src/worker/summarize';
import { LlmClient } from '../../src/ai/anthropic';
import type { AppConfig } from '../../src/config';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    slackBotToken: 'xoxb',
    slackSigningSecret: 'sig',
    anthropicApiKey: 'sk-ant',
    anthropicModel: 'claude-test',
    anthropicMaxOutputTokens: 4096,
    enableStreaming: false,
    streamMaxChunkChars: 4000,
    streamMinAppendIntervalMs: 0,
    ...overrides,
  };
}

function makeWebClient(history: unknown[]): { client: WebClient; spies: Record<string, jest.Mock> } {
  const postMessage = jest.fn().mockResolvedValue({ ok: true, ts: '1.1' });
  const conversationsHistory = jest.fn().mockResolvedValue({ messages: history });
  const conversationsInfo = jest.fn().mockResolvedValue({ channel: { name: 'demo' } });
  const usersInfo = jest.fn().mockResolvedValue({ user: { profile: { real_name: 'Alice' } } });
  const authTest = jest.fn().mockResolvedValue({ user_id: 'UBOT' });
  const chatGetPermalink = jest.fn().mockResolvedValue({ permalink: 'https://slack/p/1' });

  const client = {
    chat: { postMessage, getPermalink: chatGetPermalink },
    conversations: { history: conversationsHistory, info: conversationsInfo },
    users: { info: usersInfo },
    auth: { test: authTest },
  } as unknown as WebClient;

  return {
    client,
    spies: {
      postMessage,
      conversationsHistory,
      conversationsInfo,
      usersInfo,
      authTest,
      chatGetPermalink,
    },
  };
}

function makeLlm(): LlmClient {
  return new LlmClient({ apiKey: 'sk-ant', model: 'claude-test' });
}

describe('runSummarization (non-streaming)', () => {
  it('posts a no-messages reply when history is empty', async () => {
    const { client, spies } = makeWebClient([]);
    await runSummarization({
      config: makeConfig(),
      client,
      request: {
        correlationId: 'cid',
        userId: 'U1',
        channelId: 'C1',
        originChannelId: 'D1',
        threadTs: '1.0',
        messageCount: 25,
        customStyle: null,
      },
      llm: makeLlm(),
    });
    expect(spies.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D1',
        thread_ts: '1.0',
        text: expect.stringContaining('Nothing to summarize in <#C1>'),
      })
    );
  });

  it('runs the full non-streaming flow and posts the summary with action buttons', async () => {
    const messages = [{ ts: '1', user: 'U1', text: 'hello world', files: [] }];
    const { client, spies } = makeWebClient(messages);

    const llm = makeLlm();
    jest.spyOn(llm, 'generateSummary').mockResolvedValue('*Summary*\nthings');

    await runSummarization({
      config: makeConfig(),
      client,
      request: {
        correlationId: 'cid',
        userId: 'U1',
        channelId: 'C123',
        originChannelId: 'D1',
        threadTs: '1.0',
        messageCount: 25,
        customStyle: null,
      },
      llm,
    });

    expect(spies.conversationsHistory).toHaveBeenCalled();
    expect(llm.generateSummary).toHaveBeenCalled();
    const call = spies.postMessage.mock.calls.find((c) =>
      Array.isArray(c[0]?.blocks) &&
      c[0].blocks.some(
        (b: { type: string; text?: string }) =>
          b.type === 'markdown' && typeof b.text === 'string' && b.text.includes('**Summary of #demo**')
      )
    );
    expect(call).toBeDefined();
    const args = call![0];
    expect(args.thread_ts).toBe('1.0');
    const actions = (args.blocks as Array<{ type: string; elements?: Array<{ action_id: string }> }>).find(
      (b) => b.type === 'actions'
    );
    expect(actions?.elements?.map((e) => e.action_id)).toContain('share_summary');
  });

  it('posts the canonical failure message when the model errors', async () => {
    const messages = [{ ts: '1', user: 'U1', text: 'hello', files: [] }];
    const { client, spies } = makeWebClient(messages);
    const llm = makeLlm();
    jest.spyOn(llm, 'generateSummary').mockRejectedValue(new Error('boom'));

    await runSummarization({
      config: makeConfig(),
      client,
      request: {
        correlationId: 'cid',
        userId: 'U1',
        channelId: 'C1',
        originChannelId: 'D1',
        threadTs: '1.0',
        messageCount: 25,
        customStyle: null,
      },
      llm,
    });

    const fail = spies.postMessage.mock.calls.find((c) =>
      typeof c[0]?.text === 'string' && c[0].text.includes("Sorry, I couldn't")
    );
    expect(fail).toBeDefined();
  });
});

describe('runSummarization (streaming)', () => {
  it('routes to the streaming pipeline when enableStreaming is true', async () => {
    const messages = [{ ts: '1', user: 'U1', text: 'hello', files: [] }];
    const { client, spies } = makeWebClient(messages);

    const startStream = jest.fn().mockResolvedValue({ ok: true, ts: 'STREAM1' });
    const appendStream = jest.fn().mockResolvedValue({ ok: true });
    const stopStream = jest.fn().mockResolvedValue({ ok: true });
    (client.chat as Record<string, unknown>).startStream = startStream;
    (client.chat as Record<string, unknown>).appendStream = appendStream;
    (client.chat as Record<string, unknown>).stopStream = stopStream;

    const llm = makeLlm();
    jest.spyOn(llm, 'generateSummaryStream').mockResolvedValue({
      kind: 'active',
      iterator: (async function* () {
        yield { kind: 'text_delta', delta: 'hello world' };
        yield { kind: 'completed' };
      })(),
      cancel: async () => {},
    });

    await runSummarization({
      config: makeConfig({ enableStreaming: true }),
      client,
      request: {
        correlationId: 'cid',
        userId: 'U1',
        channelId: 'C1',
        originChannelId: 'D1',
        threadTs: '1.0',
        messageCount: 5,
        customStyle: null,
      },
      llm,
    });

    expect(startStream).toHaveBeenCalled();
    expect(stopStream).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'D1', ts: 'STREAM1', blocks: expect.any(Array) })
    );
    expect(spies.conversationsHistory).toHaveBeenCalled();
  });

  it('posts a too-large message inline when the prompt is too big', async () => {
    const messages = [{ ts: '1', user: 'U1', text: 'hello', files: [] }];
    const { client, spies } = makeWebClient(messages);

    const llm = makeLlm();
    jest.spyOn(llm, 'generateSummaryStream').mockResolvedValue({ kind: 'too_large' });

    await runSummarization({
      config: makeConfig({ enableStreaming: true }),
      client,
      request: {
        correlationId: 'cid',
        userId: 'U1',
        channelId: 'C1',
        originChannelId: 'D1',
        threadTs: '1.0',
        messageCount: 5,
        customStyle: null,
      },
      llm,
    });

    const call = spies.postMessage.mock.calls.find((c) =>
      typeof c[0]?.text === 'string' && c[0].text.includes('too long to summarize')
    );
    expect(call).toBeDefined();
  });
});

describe.each([false, true])('delivered coverage (streaming=%s)', (enableStreaming) => {
  it('uses included messages for the title, sharing, and metadata after filtering TLDR', async () => {
    const { client, spies } = makeWebClient([
      { ts: '1788829200.000001', user: 'UBOT', text: 'Earlier TLDR output' },
      { ts: '1788827400.000003', user: 'U1', text: 'Third message' },
      { ts: '1788826500.000002', user: 'U1', text: 'Second message' },
      { ts: '1788825600.000001', user: 'U1', text: 'First message' },
    ]);
    const startStream = jest.fn().mockResolvedValue({ ts: 'STREAM1' });
    const appendStream = jest.fn().mockResolvedValue({ ok: true });
    const stopStream = jest.fn().mockResolvedValue({ ok: true });
    Object.assign(client.chat, { startStream, appendStream, stopStream });
    const llm = makeLlm();
    const recap = 'A brief recap with <!channel> and <@U123>.';
    jest.spyOn(llm, 'generateSummary').mockResolvedValue(recap);
    jest.spyOn(llm, 'generateSummaryStream').mockResolvedValue({
      kind: 'active',
      iterator: (async function* () { yield { kind: 'text_delta' as const, delta: recap }; yield { kind: 'completed' as const }; })(),
      cancel: async () => {},
    });

    const result = await runSummarization({
      client, llm, config: makeConfig({ enableStreaming }),
      request: { correlationId: 'coverage', userId: 'U1', channelId: 'C1', originChannelId: 'D1', threadTs: '1.0', messageCount: 25, customStyle: null },
    });
    expect(result).toBe('delivered');
    const delivered = enableStreaming ? stopStream.mock.calls[0][0] : spies.postMessage.mock.calls[0][0];
    const body = enableStreaming
      ? startStream.mock.calls[0][0].markdown_text + appendStream.mock.calls.map((call) => call[0].markdown_text).join('')
      : delivered.text;
    expect(body).toContain('3 messages · Sep 8, 2026 · 00:00–00:30 UTC');
    expect(body).not.toContain('25 messages');
    expect(body).toContain('`<!channel>`');
    expect(body).toContain('`<@U123>`');
    expect(delivered.metadata.event_payload).toEqual({
      source_channel_id: 'C1', message_count: 3, requested_message_count: 25,
      has_style: false, oldest_ts: '1788825600.000001', latest_ts: '1788827400.000003',
    });
    const actions = delivered.blocks.find((block: { type: string }) => block.type === 'actions');
    const share = actions.elements.find((element: { action_id: string }) => element.action_id === 'share_summary');
    expect(JSON.parse(share.value).count).toBe(3);
  });
});
