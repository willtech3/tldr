import type { WebClient } from '@slack/web-api';
import {
  CANONICAL_FAILURE_MESSAGE,
  buildStreamPrefix,
  streamSummaryToAssistantThread,
} from '../../src/worker/streaming';
import { LlmClient, type StreamEvent, type StreamingResponse } from '../../src/ai/anthropic';

describe('buildStreamPrefix', () => {
  it('includes only the channel header when no style is set', () => {
    expect(buildStreamPrefix('C123', null)).toBe('*Summary from <#C123>*\n\n');
  });

  it('prepends a style header when set', () => {
    const prefix = buildStreamPrefix('C123', 'be cool');
    expect(prefix).toBe('_Style: be cool_\n\n*Summary from <#C123>*\n\n');
  });

  it('truncates long style headers to 60 chars + ellipsis', () => {
    const long = 'x'.repeat(120);
    const prefix = buildStreamPrefix('C123', long);
    expect(prefix.startsWith('_Style: ')).toBe(true);
    // Style portion = 57 chars + "..." == 60
    const styleSegment = prefix.split('_Style: ')[1].split('_\n\n')[0];
    expect([...styleSegment].length).toBe(60);
    expect(styleSegment.endsWith('...')).toBe(true);
  });

  it('drops empty/whitespace styles', () => {
    expect(buildStreamPrefix('C1', '   ')).toBe('*Summary from <#C1>*\n\n');
  });
});

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const SINGLE_MESSAGE = [{ ts: '1', user: 'U1', text: 'hello world', files: [] }];

function activeStream(events: StreamEvent[]): StreamingResponse {
  return {
    kind: 'active',
    iterator: (async function* () {
      for (const event of events) {
        yield event;
      }
    })(),
    cancel: async () => {},
  };
}

interface ClientOverrides {
  update?: jest.Mock;
}

function makeClient(history: unknown[], overrides: ClientOverrides = {}) {
  const postMessage = jest.fn().mockResolvedValue({ ok: true, ts: 'POST1' });
  const update = overrides.update ?? jest.fn().mockResolvedValue({ ok: true });
  const deleteFn = jest.fn().mockResolvedValue({ ok: true });
  const startStream = jest.fn().mockResolvedValue({ ok: true, ts: 'STREAM1' });
  const appendStream = jest.fn().mockResolvedValue({ ok: true });
  const stopStream = jest.fn().mockResolvedValue({ ok: true });
  const getPermalink = jest
    .fn()
    .mockResolvedValue({ permalink: 'https://acme.slack.com/archives/C1/p1' });
  const conversationsHistory = jest.fn().mockResolvedValue({ messages: history });
  const conversationsInfo = jest.fn().mockResolvedValue({ channel: { name: 'demo' } });
  const usersInfo = jest.fn().mockResolvedValue({ user: { profile: { real_name: 'Alice' } } });
  const authTest = jest.fn().mockResolvedValue({ user_id: 'UBOT' });

  const client = {
    chat: { postMessage, update, delete: deleteFn, startStream, appendStream, stopStream, getPermalink },
    conversations: { history: conversationsHistory, info: conversationsInfo },
    users: { info: usersInfo },
    auth: { test: authTest },
  } as unknown as WebClient;

  return {
    client,
    spies: { postMessage, update, delete: deleteFn, startStream, appendStream, stopStream },
  };
}

function baseArgs(client: WebClient, llm: LlmClient) {
  return {
    client,
    llm,
    botToken: 'xoxb',
    sourceChannelId: 'C1',
    assistantChannelId: 'D1',
    assistantThreadTs: '1.0',
    messageCount: 5,
    customStyle: null as string | null,
    correlationId: 'cid',
    streamMaxChunkChars: 4000,
    streamMinAppendIntervalMs: 0,
    sleep: async () => {},
  };
}

function makeLlm(): LlmClient {
  return new LlmClient({ apiKey: 'sk-ant-test', model: 'claude-test' });
}

function canonicalPostCalls(postMessage: jest.Mock): unknown[] {
  return postMessage.mock.calls.filter(
    (c) => typeof c[0]?.text === 'string' && c[0].text.includes(CANONICAL_FAILURE_MESSAGE)
  );
}

describe('streamSummaryToAssistantThread', () => {
  it('streams the summary and finalises with action buttons', async () => {
    const { client, spies } = makeClient(SINGLE_MESSAGE);
    const llm = makeLlm();
    jest
      .spyOn(llm, 'generateSummaryStream')
      .mockResolvedValue(
        activeStream([
          { kind: 'text_delta', delta: '*Summary*\nThings happened.' },
          { kind: 'completed' },
        ])
      );

    await streamSummaryToAssistantThread(baseArgs(client, llm), silentLogger);

    expect(spies.startStream).toHaveBeenCalledTimes(1);
    const startArg = spies.startStream.mock.calls[0][0];
    expect(startArg.markdown_text).toContain('*Summary from <#C1>*');
    expect(startArg.markdown_text).toContain('Things happened.');

    // Finalised with the interactive action buttons.
    expect(spies.stopStream).toHaveBeenCalledTimes(1);
    const stopArg = spies.stopStream.mock.calls[0][0];
    expect(stopArg.ts).toBe('STREAM1');
    const actions = (stopArg.blocks as Array<{ elements: Array<{ action_id: string }> }>)[0];
    expect(actions.elements.map((e) => e.action_id)).toContain('share_summary');

    // Happy path posts no canonical error.
    expect(canonicalPostCalls(spies.postMessage)).toHaveLength(0);
  });

  it('posts a no-messages reply and never starts a stream when history is empty', async () => {
    const { client, spies } = makeClient([]);
    const llm = makeLlm();
    const streamSpy = jest.spyOn(llm, 'generateSummaryStream');

    await streamSummaryToAssistantThread(baseArgs(client, llm), silentLogger);

    expect(spies.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'No messages found to summarize.' })
    );
    expect(spies.startStream).not.toHaveBeenCalled();
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it('posts the friendly too-large message inline without starting a stream', async () => {
    const { client, spies } = makeClient(SINGLE_MESSAGE);
    const llm = makeLlm();
    jest.spyOn(llm, 'generateSummaryStream').mockResolvedValue({ kind: 'too_large' });

    await streamSummaryToAssistantThread(baseArgs(client, llm), silentLogger);

    expect(spies.startStream).not.toHaveBeenCalled();
    const tooLarge = spies.postMessage.mock.calls.find(
      (c) => typeof c[0]?.text === 'string' && c[0].text.includes('too long to summarize')
    );
    expect(tooLarge).toBeDefined();
  });

  it('posts a single canonical failure when the stream fails before starting', async () => {
    const { client, spies } = makeClient(SINGLE_MESSAGE);
    const llm = makeLlm();
    jest
      .spyOn(llm, 'generateSummaryStream')
      .mockResolvedValue(activeStream([{ kind: 'failed', message: 'boom' }]));

    await expect(
      streamSummaryToAssistantThread(baseArgs(client, llm), silentLogger)
    ).rejects.toThrow('boom');

    expect(spies.startStream).not.toHaveBeenCalled();
    expect(canonicalPostCalls(spies.postMessage)).toHaveLength(1);
  });

  it('replaces the partial message (not a duplicate) when the stream fails mid-way', async () => {
    // Regression: a failure *after* startStream must overwrite the streamed
    // message via chat.update rather than orphan it and post a fresh error.
    const { client, spies } = makeClient(SINGLE_MESSAGE);
    const llm = makeLlm();
    jest.spyOn(llm, 'generateSummaryStream').mockResolvedValue(
      activeStream([
        { kind: 'text_delta', delta: '*Summary*\npartial output...' },
        { kind: 'failed', message: 'midstream boom' },
      ])
    );

    await expect(
      streamSummaryToAssistantThread(baseArgs(client, llm), silentLogger)
    ).rejects.toThrow('midstream boom');

    expect(spies.startStream).toHaveBeenCalledTimes(1);
    expect(spies.update).toHaveBeenCalledWith(
      expect.objectContaining({ ts: 'STREAM1', text: CANONICAL_FAILURE_MESSAGE })
    );
    // No duplicate canonical message posted as a fresh thread reply.
    expect(canonicalPostCalls(spies.postMessage)).toHaveLength(0);
  });
});
