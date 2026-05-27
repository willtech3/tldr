import {
  LlmClient,
  TOO_LARGE_MESSAGE,
  isPromptTooLargeError,
} from '../../src/ai/anthropic';
import { buildPrompt } from '../../src/ai/prompt';

describe('isPromptTooLargeError', () => {
  it('recognises Anthropic "prompt is too long" errors', () => {
    expect(isPromptTooLargeError(new Error('prompt is too long'))).toBe(true);
    expect(isPromptTooLargeError(new Error('input is too long for context window'))).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isPromptTooLargeError(new Error('rate limited'))).toBe(false);
    expect(isPromptTooLargeError(null)).toBe(false);
  });
});

describe('LlmClient.generateSummary', () => {
  function makePrompt() {
    return buildPrompt({
      channelName: 'demo',
      formattedMessages: ['[170] alice: hi'],
      linksShared: [],
      receipts: [],
      images: [],
      customStyle: null,
    });
  }

  it('returns text from a non-streaming Anthropic response', async () => {
    const response = {
      content: [{ type: 'text', text: 'hello world' }],
    };
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const client = new LlmClient({
      apiKey: 'sk-ant-test',
      model: 'claude-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.generateSummary(makePrompt());
    expect(result).toBe('hello world');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const requestUrl = String(fetchImpl.mock.calls[0][0]);
    expect(requestUrl).toContain('/v1/messages');
  });

  it('returns the friendly TOO_LARGE_MESSAGE when Anthropic rejects an oversize prompt', async () => {
    const errorBody = JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long: ...' },
    });
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response(errorBody, { status: 400, headers: { 'Content-Type': 'application/json' } }));
    const client = new LlmClient({
      apiKey: 'sk-ant-test',
      model: 'claude-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.generateSummary(makePrompt());
    expect(result).toBe(TOO_LARGE_MESSAGE);
  });

  it('rethrows non-too-large errors', async () => {
    const errorBody = JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid api key' },
    });
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response(errorBody, { status: 401, headers: { 'Content-Type': 'application/json' } }));
    const client = new LlmClient({
      apiKey: 'sk-ant-test',
      model: 'claude-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.generateSummary(makePrompt())).rejects.toThrow();
  });
});

describe('LlmClient.generateSummaryStream', () => {
  function makePrompt() {
    return buildPrompt({
      channelName: 'demo',
      formattedMessages: ['[170] alice: hi'],
      linksShared: [],
      receipts: [],
      images: [],
      customStyle: null,
    });
  }

  it('yields text_delta events from an Anthropic SSE stream', async () => {
    const sseBody = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"m_1","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" World"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody));
        controller.close();
      },
    });
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const client = new LlmClient({
      apiKey: 'sk-ant-test',
      model: 'claude-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const streaming = await client.generateSummaryStream(makePrompt());
    expect(streaming.kind).toBe('active');
    if (streaming.kind !== 'active') {
      return;
    }
    const events: Array<{ kind: string; delta?: string }> = [];
    while (true) {
      const { value, done } = await streaming.iterator.next();
      if (done) {
        break;
      }
      events.push({ kind: value.kind, delta: 'delta' in value ? value.delta : undefined });
    }
    expect(events).toEqual([
      { kind: 'text_delta', delta: 'Hello' },
      { kind: 'text_delta', delta: ' World' },
      { kind: 'completed', delta: undefined },
    ]);
  });
});
