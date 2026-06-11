import type { WebClient } from '@slack/web-api';
import { CHAT_FAILURE_TEXT, runGeneralChat } from '../../src/worker/chat';
import { LlmClient, type StreamEvent, type StreamingResponse } from '../../src/ai/anthropic';
import type { AppConfig } from '../../src/config';
import { resetRateLimitForTests, RATE_LIMIT_MAX_PER_MINUTE } from '../../src/security';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    slackBotToken: 'xoxb',
    slackSigningSecret: 'sig',
    anthropicApiKey: 'sk-ant',
    anthropicModel: 'claude-test',
    anthropicMaxOutputTokens: 4096,
    enableStreaming: true,
    streamMaxChunkChars: 4000,
    streamMinAppendIntervalMs: 0,
    ...overrides,
  };
}

interface ClientSpies {
  postMessage: jest.Mock;
  startStream: jest.Mock;
  appendStream: jest.Mock;
  stopStream: jest.Mock;
  chatDelete: jest.Mock;
  setStatus: jest.Mock;
  conversationsReplies: jest.Mock;
  conversationsInfo: jest.Mock;
  authTest: jest.Mock;
}

function makeWebClient(threadMessages: unknown[] = []): { client: WebClient; spies: ClientSpies } {
  const spies: ClientSpies = {
    postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '9.9' }),
    startStream: jest.fn().mockResolvedValue({ ok: true, ts: '5.5' }),
    appendStream: jest.fn().mockResolvedValue({ ok: true }),
    stopStream: jest.fn().mockResolvedValue({ ok: true }),
    chatDelete: jest.fn().mockResolvedValue({ ok: true }),
    setStatus: jest.fn().mockResolvedValue({ ok: true }),
    conversationsReplies: jest.fn().mockResolvedValue({ messages: threadMessages }),
    conversationsInfo: jest.fn().mockResolvedValue({ channel: { name: 'demo' } }),
    authTest: jest.fn().mockResolvedValue({ user_id: 'UBOT' }),
  };
  const client = {
    chat: {
      postMessage: spies.postMessage,
      startStream: spies.startStream,
      appendStream: spies.appendStream,
      stopStream: spies.stopStream,
      delete: spies.chatDelete,
    },
    assistant: { threads: { setStatus: spies.setStatus } },
    conversations: { replies: spies.conversationsReplies, info: spies.conversationsInfo },
    auth: { test: spies.authTest },
  } as unknown as WebClient;
  return { client, spies };
}

function makeStream(events: StreamEvent[]): StreamingResponse {
  let i = 0;
  return {
    kind: 'active',
    iterator: {
      async next(): Promise<IteratorResult<StreamEvent, void>> {
        if (i < events.length) {
          return { done: false, value: events[i++] };
        }
        return { done: true, value: undefined };
      },
    },
    cancel: jest.fn().mockResolvedValue(undefined),
  };
}

function makeLlm(stream: StreamingResponse): LlmClient {
  const llm = new LlmClient({ apiKey: 'sk-ant', model: 'claude-test' });
  jest.spyOn(llm, 'generateSummaryStream').mockResolvedValue(stream);
  return llm;
}

const logger = { warn: jest.fn(), error: jest.fn() };

function baseArgs(client: WebClient, llm: LlmClient, overrides: Record<string, unknown> = {}) {
  return {
    client,
    config: makeConfig(),
    userId: 'U1',
    assistantChannelId: 'D1',
    assistantThreadTs: '1.0',
    userText: 'hey, who are you?',
    userMessageTs: '2.0',
    viewingChannelId: null,
    logger,
    llm,
    ...overrides,
  };
}

beforeEach(() => {
  resetRateLimitForTests();
  jest.clearAllMocks();
});

describe('runGeneralChat (streaming)', () => {
  it('streams the model reply into the thread and finalises it', async () => {
    const { client, spies } = makeWebClient();
    const llm = makeLlm(
      makeStream([
        { kind: 'text_delta', delta: 'Ahoy! ' },
        { kind: 'text_delta', delta: 'I am TLDR.' },
        { kind: 'completed' },
      ])
    );

    const outcome = await runGeneralChat(baseArgs(client, llm));

    expect(outcome).toBe('delivered');
    expect(spies.setStatus).toHaveBeenCalled();
    expect(spies.startStream).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'D1', thread_ts: '1.0' })
    );
    const appended = spies.appendStream.mock.calls
      .map((c) => c[0].markdown_text)
      .join('');
    expect(appended).toBe('Ahoy! I am TLDR.');
    expect(spies.stopStream).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'D1', ts: '5.5' })
    );
  });

  it('passes thread history and the user message to the prompt', async () => {
    const { client } = makeWebClient([
      { ts: '0.5', user: 'U1', text: 'summarize' },
      // Bot messages carry the bot's own user ID, not a missing `user`.
      { ts: '0.6', user: 'UBOT', text: 'Summary of #demo ...' },
      { ts: '2.0', user: 'U1', text: 'hey, who are you?' }, // triggering msg — excluded
    ]);
    const llm = makeLlm(makeStream([{ kind: 'text_delta', delta: 'hi' }, { kind: 'completed' }]));

    await runGeneralChat(baseArgs(client, llm));

    const prompt = (llm.generateSummaryStream as jest.Mock).mock.calls[0][0];
    const text = prompt.userContent[0].text as string;
    expect(text).toContain('User: summarize');
    expect(text).toContain('TLDR: Summary of #demo ...');
    expect(text).toContain('hey, who are you?');
    // The triggering message must not also appear as history.
    expect(text.match(/hey, who are you\?/g)).toHaveLength(1);
  });

  it('includes the viewing channel name when known', async () => {
    const { client, spies } = makeWebClient();
    const llm = makeLlm(makeStream([{ kind: 'text_delta', delta: 'hi' }, { kind: 'completed' }]));

    await runGeneralChat(baseArgs(client, llm, { viewingChannelId: 'C123456789' }));

    expect(spies.conversationsInfo).toHaveBeenCalledWith({ channel: 'C123456789' });
    const prompt = (llm.generateSummaryStream as jest.Mock).mock.calls[0][0];
    expect(prompt.userContent[0].text).toContain('#demo');
  });

  it('cleans up the stream and posts the nudge fallback when the model fails mid-stream', async () => {
    const { client, spies } = makeWebClient();
    const llm = makeLlm(
      makeStream([
        { kind: 'text_delta', delta: 'partial' },
        { kind: 'failed', message: 'boom' },
      ])
    );

    const outcome = await runGeneralChat(baseArgs(client, llm));

    expect(outcome).toBe('failed');
    expect(spies.stopStream).toHaveBeenCalled();
    expect(spies.chatDelete).toHaveBeenCalledWith({ channel: 'D1', ts: '5.5' });
    expect(spies.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: CHAT_FAILURE_TEXT })
    );
  });

  it('treats an append onto a finalised message as a user stop', async () => {
    const { client, spies } = makeWebClient();
    spies.appendStream.mockRejectedValue(
      Object.assign(new Error('message_not_in_streaming_state'), {
        data: { error: 'message_not_in_streaming_state' },
      })
    );
    const llm = makeLlm(
      makeStream([{ kind: 'text_delta', delta: 'hello there' }, { kind: 'completed' }])
    );

    const outcome = await runGeneralChat(baseArgs(client, llm));

    expect(outcome).toBe('stopped');
    expect(spies.postMessage).not.toHaveBeenCalled();
  });

  it('still answers when thread history cannot be loaded', async () => {
    const { client, spies } = makeWebClient();
    spies.conversationsReplies.mockRejectedValue(new Error('nope'));
    const llm = makeLlm(makeStream([{ kind: 'text_delta', delta: 'hi' }, { kind: 'completed' }]));

    const outcome = await runGeneralChat(baseArgs(client, llm));

    expect(outcome).toBe('delivered');
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('runGeneralChat (non-streaming)', () => {
  it('posts the full reply as a markdown block', async () => {
    const { client, spies } = makeWebClient();
    const llm = new LlmClient({ apiKey: 'sk-ant', model: 'claude-test' });
    jest.spyOn(llm, 'generateSummary').mockResolvedValue('Plain reply.');

    const outcome = await runGeneralChat(
      baseArgs(client, llm, { config: makeConfig({ enableStreaming: false }) })
    );

    expect(outcome).toBe('delivered');
    expect(spies.startStream).not.toHaveBeenCalled();
    expect(spies.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D1',
        thread_ts: '1.0',
        blocks: [{ type: 'markdown', text: 'Plain reply.' }],
      })
    );
  });
});

describe('runGeneralChat (rate limiting)', () => {
  it('refuses with the rate-limit message once the per-user budget is spent', async () => {
    const { client, spies } = makeWebClient();
    const llm = makeLlm(makeStream([{ kind: 'text_delta', delta: 'hi' }, { kind: 'completed' }]));

    for (let i = 0; i < RATE_LIMIT_MAX_PER_MINUTE; i++) {
      await runGeneralChat(baseArgs(client, llm));
    }
    const outcome = await runGeneralChat(baseArgs(client, llm));

    expect(outcome).toBe('rate_limited');
    expect(spies.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Easy there') })
    );
  });
});
