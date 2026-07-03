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
  postEphemeral: jest.Mock;
  startStream: jest.Mock;
  appendStream: jest.Mock;
  stopStream: jest.Mock;
  chatDelete: jest.Mock;
  setStatus: jest.Mock;
  conversationsReplies: jest.Mock;
  conversationsInfo: jest.Mock;
  authTest: jest.Mock;
  usersInfo: jest.Mock;
}

function makeWebClient(threadMessages: unknown[] = []): { client: WebClient; spies: ClientSpies } {
  const spies: ClientSpies = {
    postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '9.9' }),
    postEphemeral: jest.fn().mockResolvedValue({ ok: true }),
    startStream: jest.fn().mockResolvedValue({ ok: true, ts: '5.5' }),
    appendStream: jest.fn().mockResolvedValue({ ok: true }),
    stopStream: jest.fn().mockResolvedValue({ ok: true }),
    chatDelete: jest.fn().mockResolvedValue({ ok: true }),
    setStatus: jest.fn().mockResolvedValue({ ok: true }),
    conversationsReplies: jest.fn().mockResolvedValue({ messages: threadMessages }),
    conversationsInfo: jest.fn().mockResolvedValue({ channel: { name: 'demo' } }),
    authTest: jest.fn().mockResolvedValue({ user_id: 'UBOT' }),
    usersInfo: jest.fn().mockImplementation(({ user }: { user: string }) =>
      Promise.resolve({ user: { profile: { real_name: `name-${user}` } } })
    ),
  };
  const client = {
    chat: {
      postMessage: spies.postMessage,
      postEphemeral: spies.postEphemeral,
      startStream: spies.startStream,
      appendStream: spies.appendStream,
      stopStream: spies.stopStream,
      delete: spies.chatDelete,
    },
    assistant: { threads: { setStatus: spies.setStatus } },
    conversations: { replies: spies.conversationsReplies, info: spies.conversationsInfo },
    auth: { test: spies.authTest },
    users: { info: spies.usersInfo },
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
    surface: 'assistant' as const,
    channelId: 'D1',
    threadTs: '1.0',
    userText: 'hey, who are you?',
    userMessageTs: '2.0',
    viewingChannelId: null,
    logger,
    llm,
    ...overrides,
  };
}

function channelArgs(client: WebClient, llm: LlmClient, overrides: Record<string, unknown> = {}) {
  return baseArgs(client, llm, {
    surface: 'channel' as const,
    channelId: 'C42',
    threadTs: '10.0',
    userMessageTs: '11.0',
    recipientTeamId: 'T1',
    ...overrides,
  });
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

  it('rate-limits ephemerally on the channel surface — no channel noise', async () => {
    const { client, spies } = makeWebClient();
    const llm = makeLlm(makeStream([{ kind: 'text_delta', delta: 'hi' }, { kind: 'completed' }]));

    for (let i = 0; i < RATE_LIMIT_MAX_PER_MINUTE; i++) {
      await runGeneralChat(channelArgs(client, llm));
    }
    spies.postMessage.mockClear();
    const outcome = await runGeneralChat(channelArgs(client, llm));

    expect(outcome).toBe('rate_limited');
    expect(spies.postMessage).not.toHaveBeenCalled();
    expect(spies.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C42',
        user: 'U1',
        thread_ts: '10.0',
        text: expect.stringContaining('Easy there'),
      })
    );
  });
});

describe('runGeneralChat (channel surface)', () => {
  it('streams into the channel thread with recipient routing and no assistant status', async () => {
    const { client, spies } = makeWebClient();
    const llm = makeLlm(
      makeStream([{ kind: 'text_delta', delta: 'Sure thing.' }, { kind: 'completed' }])
    );

    const outcome = await runGeneralChat(channelArgs(client, llm));

    expect(outcome).toBe('delivered');
    expect(spies.setStatus).not.toHaveBeenCalled();
    expect(spies.startStream).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C42',
        thread_ts: '10.0',
        recipient_user_id: 'U1',
        recipient_team_id: 'T1',
      })
    );
  });

  it('names thread participants in the prompt so the model can attribute turns', async () => {
    const { client } = makeWebClient([
      { ts: '9.0', user: 'UA', text: 'I think we should ship Friday' },
      { ts: '9.5', user: 'UB', text: 'strong disagree' },
      { ts: '9.8', user: 'UBOT', text: 'Earlier bot reply' },
      { ts: '11.0', user: 'U1', text: '<@UBOT> who is right?' }, // trigger — excluded
    ]);
    const llm = makeLlm(makeStream([{ kind: 'text_delta', delta: 'hi' }, { kind: 'completed' }]));

    await runGeneralChat(channelArgs(client, llm));

    const prompt = (llm.generateSummaryStream as jest.Mock).mock.calls[0][0];
    const text = prompt.userContent[0].text as string;
    expect(text).toContain('name-UA: I think we should ship Friday');
    expect(text).toContain('name-UB: strong disagree');
    expect(text).toContain('TLDR: Earlier bot reply');
    expect(text).toContain('@-mentioned in a message thread');
    expect(text).toContain('#demo');
  });

  it('falls back to a single message when chat.startStream is unavailable', async () => {
    const { client, spies } = makeWebClient();
    spies.startStream.mockRejectedValue(new Error('streaming_not_allowed'));
    const llm = makeLlm(
      makeStream([
        { kind: 'text_delta', delta: 'Full ' },
        { kind: 'text_delta', delta: 'reply.' },
        { kind: 'completed' },
      ])
    );

    const outcome = await runGeneralChat(channelArgs(client, llm));

    expect(outcome).toBe('delivered');
    expect(spies.appendStream).not.toHaveBeenCalled();
    expect(spies.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C42',
        thread_ts: '10.0',
        blocks: [{ type: 'markdown', text: 'Full reply.' }],
      })
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it('posts a plain-text failure fallback — assistant nudge buttons stay off channels', async () => {
    const { client, spies } = makeWebClient();
    const llm = makeLlm(makeStream([{ kind: 'failed', message: 'boom' }]));

    const outcome = await runGeneralChat(channelArgs(client, llm));

    expect(outcome).toBe('failed');
    const fallback = spies.postMessage.mock.calls.find((c) => c[0].text === CHAT_FAILURE_TEXT);
    expect(fallback).toBeDefined();
    expect(fallback?.[0].blocks).toBeUndefined();
  });
});
