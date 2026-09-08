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

function makeLlm(stream: StreamingResponse | (() => StreamingResponse)): LlmClient {
  const llm = new LlmClient({ apiKey: 'sk-ant', model: 'claude-test' });
  jest.spyOn(llm, 'generateSummaryStream').mockImplementation(async () =>
    typeof stream === 'function' ? stream() : stream
  );
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
    expect(spies.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: '💬 Thinking...' })
    );
    expect(spies.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: '' }));
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

  it('cleans up a failed stream and retries with a full model reply', async () => {
    const { client, spies } = makeWebClient();
    const llm = makeLlm(
      makeStream([
        { kind: 'text_delta', delta: 'partial' },
        { kind: 'failed', message: 'boom' },
      ])
    );
    jest.spyOn(llm, 'generateSummary').mockResolvedValue('Recovered model reply.');

    const outcome = await runGeneralChat(baseArgs(client, llm));

    expect(outcome).toBe('delivered');
    expect(spies.stopStream).toHaveBeenCalled();
    expect(spies.chatDelete).toHaveBeenCalledWith({ channel: 'D1', ts: '5.5' });
    expect(llm.generateSummary).toHaveBeenCalledTimes(1);
    expect(spies.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Recovered model reply.',
        blocks: [{ type: 'markdown', text: 'Recovered model reply.' }],
      })
    );
    expect(spies.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: CHAT_FAILURE_TEXT })
    );
  });

  it('only posts the nudge after both streaming and full model attempts fail', async () => {
    const { client, spies } = makeWebClient();
    const llm = makeLlm(makeStream([{ kind: 'failed', message: 'stream failed' }]));
    jest.spyOn(llm, 'generateSummary').mockRejectedValue(new Error('retry failed'));

    const outcome = await runGeneralChat(baseArgs(client, llm));

    expect(outcome).toBe('failed');
    expect(llm.generateSummary).toHaveBeenCalledTimes(1);
    expect(spies.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: CHAT_FAILURE_TEXT })
    );
    const posted = spies.postMessage.mock.calls.find((c) => c[0].text === CHAT_FAILURE_TEXT);
    expect(JSON.stringify(posted?.[0].blocks)).toContain(CHAT_FAILURE_TEXT);
    expect(JSON.stringify(posted?.[0].blocks)).not.toContain("didn't catch that");
    expect(spies.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: '' }));
  });

  it('keeps a fully-delivered reply when the final stopStream fails — no duplicate', async () => {
    const { client, spies } = makeWebClient();
    spies.stopStream.mockRejectedValue(new Error('fetch timeout'));
    const llm = makeLlm(
      makeStream([{ kind: 'text_delta', delta: 'Complete answer.' }, { kind: 'completed' }])
    );
    const generateSummary = jest.spyOn(llm, 'generateSummary');

    const outcome = await runGeneralChat(baseArgs(client, llm));

    expect(outcome).toBe('delivered');
    // Every token reached the message: no delete, no second model call,
    // no duplicate reply, no failure card.
    expect(spies.chatDelete).not.toHaveBeenCalled();
    expect(generateSummary).not.toHaveBeenCalled();
    expect(spies.postMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('cleans up and retries as a full reply when a drain-phase append fails', async () => {
    const { client, spies } = makeWebClient();
    // A large min-append interval keeps every token in `pending` until the
    // post-completion drain — whose append then fails hard.
    spies.appendStream.mockRejectedValue(
      Object.assign(new Error('internal_error'), { data: { error: 'internal_error' } })
    );
    const llm = makeLlm(
      makeStream([
        { kind: 'text_delta', delta: 'part one ' },
        { kind: 'text_delta', delta: 'part two' },
        { kind: 'completed' },
      ])
    );
    jest.spyOn(llm, 'generateSummary').mockResolvedValue('Recovered full reply.');

    const outcome = await runGeneralChat(
      baseArgs(client, llm, {
        config: makeConfig({ streamMinAppendIntervalMs: 10_000 }),
        sleep: async (): Promise<void> => undefined,
      })
    );

    // The partial streamed message is removed and the retry delivers once.
    expect(outcome).toBe('delivered');
    expect(spies.chatDelete).toHaveBeenCalledWith({ channel: 'D1', ts: '5.5' });
    expect(llm.generateSummary).toHaveBeenCalledTimes(1);
    expect(spies.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Recovered full reply.' })
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
    // Every allowed request needs its own iterator; a reused stream is exhausted
    // after the first call and would enter the full-response retry path.
    const llm = makeLlm(() =>
      makeStream([{ kind: 'text_delta', delta: 'hi' }, { kind: 'completed' }])
    );
    const fallback = jest.spyOn(llm, 'generateSummary').mockRejectedValue(
      new Error('Unexpected non-streaming fallback')
    );

    for (let i = 0; i < RATE_LIMIT_MAX_PER_MINUTE; i++) {
      expect(await runGeneralChat(baseArgs(client, llm))).toBe('delivered');
    }
    const outcome = await runGeneralChat(baseArgs(client, llm));

    expect(outcome).toBe('rate_limited');
    expect(llm.generateSummaryStream).toHaveBeenCalledTimes(RATE_LIMIT_MAX_PER_MINUTE);
    expect(fallback).not.toHaveBeenCalled();
    expect(spies.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('requests a minute') })
    );
  });

  it('rate-limits ephemerally on the channel surface — no channel noise', async () => {
    const { client, spies } = makeWebClient();
    // Every allowed request needs its own iterator; a reused stream is exhausted
    // after the first call and would enter the full-response retry path.
    const llm = makeLlm(() =>
      makeStream([{ kind: 'text_delta', delta: 'hi' }, { kind: 'completed' }])
    );
    const fallback = jest.spyOn(llm, 'generateSummary').mockRejectedValue(
      new Error('Unexpected non-streaming fallback')
    );

    for (let i = 0; i < RATE_LIMIT_MAX_PER_MINUTE; i++) {
      expect(await runGeneralChat(channelArgs(client, llm))).toBe('delivered');
    }
    spies.postMessage.mockClear();
    const outcome = await runGeneralChat(channelArgs(client, llm));

    expect(outcome).toBe('rate_limited');
    expect(llm.generateSummaryStream).toHaveBeenCalledTimes(RATE_LIMIT_MAX_PER_MINUTE);
    expect(fallback).not.toHaveBeenCalled();
    expect(spies.postMessage).not.toHaveBeenCalled();
    expect(spies.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C42',
        user: 'U1',
        thread_ts: '10.0',
        text: expect.stringContaining('requests a minute'),
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

  it('never attributes user-less messages (webhooks/integrations) to TLDR', async () => {
    const { client } = makeWebClient([
      { ts: '9.0', text: 'Build #42 failed: exit code 1' }, // no `user` — CI webhook
      { ts: '11.0', user: 'U1', text: '<@UBOT> what does this mean?' }, // trigger
    ]);
    const llm = makeLlm(makeStream([{ kind: 'text_delta', delta: 'hi' }, { kind: 'completed' }]));

    await runGeneralChat(channelArgs(client, llm));

    const prompt = (llm.generateSummaryStream as jest.Mock).mock.calls[0][0];
    const text = prompt.userContent[0].text as string;
    expect(text).toContain('User: Build #42 failed: exit code 1');
    expect(text).not.toContain('TLDR: Build #42 failed');
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
    jest.spyOn(llm, 'generateSummary').mockRejectedValue(new Error('retry failed'));

    const outcome = await runGeneralChat(channelArgs(client, llm));

    expect(outcome).toBe('failed');
    const fallback = spies.postMessage.mock.calls.find((c) => c[0].text === CHAT_FAILURE_TEXT);
    expect(fallback).toBeDefined();
    expect(fallback?.[0].blocks).toBeUndefined();
  });
});
