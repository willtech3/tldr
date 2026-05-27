import type { WebClient } from '@slack/web-api';
import {
  appendStream,
  downloadImageBytes,
  fetchImageHead,
  getBotUserId,
  getChannelName,
  getMessagePermalink,
  getRecentMessages,
  getUserDisplayName,
  isMessageNotInStreamingStateError,
  pickFileDownloadUrl,
  startStream,
  stopStream,
} from '../../src/slack/client';

function makeWebClient(overrides: Record<string, unknown>): WebClient {
  return overrides as unknown as WebClient;
}

describe('Slack client wrappers', () => {
  it('clamps message count to Slack limits', async () => {
    const history = jest.fn().mockResolvedValue({
      messages: [{ ts: '1', user: 'U1', text: 'hi', files: [] }],
    });
    const client = makeWebClient({ conversations: { history } });
    await getRecentMessages(client, 'C1', 10_000);
    expect(history).toHaveBeenCalledWith({ channel: 'C1', limit: 1000 });
  });

  it('maps Slack history messages onto the simplified shape', async () => {
    const history = jest.fn().mockResolvedValue({
      messages: [
        {
          ts: '1',
          user: 'U1',
          text: 'hello',
          files: [
            {
              url_private_download: 'https://files.slack.com/dl/x.png',
              url_private: 'https://files.slack.com/x.png',
              mimetype: 'image/png',
            },
          ],
        },
      ],
    });
    const client = makeWebClient({ conversations: { history } });
    const messages = await getRecentMessages(client, 'C1', 1);
    expect(messages[0]).toMatchObject({
      ts: '1',
      user: 'U1',
      text: 'hello',
      files: [
        {
          urlPrivateDownload: 'https://files.slack.com/dl/x.png',
          urlPrivate: 'https://files.slack.com/x.png',
          mimeType: 'image/png',
        },
      ],
    });
  });

  it('returns null when auth.test fails', async () => {
    const client = makeWebClient({
      auth: { test: jest.fn().mockRejectedValue(new Error('nope')) },
    });
    expect(await getBotUserId(client)).toBeNull();
  });

  it('falls back to the userId when users.info errors', async () => {
    const client = makeWebClient({
      users: { info: jest.fn().mockRejectedValue(new Error('not found')) },
    });
    expect(await getUserDisplayName(client, 'U123')).toBe('U123');
  });

  it('prefers profile.real_name then display_name then userId', async () => {
    const info = jest
      .fn()
      .mockResolvedValueOnce({ user: { profile: { real_name: 'Alice', display_name: 'a' } } })
      .mockResolvedValueOnce({ user: { profile: { display_name: 'bob' } } })
      .mockResolvedValueOnce({ user: { profile: {} } });
    const client = makeWebClient({ users: { info } });
    expect(await getUserDisplayName(client, 'U1')).toBe('Alice');
    expect(await getUserDisplayName(client, 'U2')).toBe('bob');
    expect(await getUserDisplayName(client, 'U3')).toBe('U3');
  });

  it('returns the channel ID when conversations.info fails', async () => {
    const client = makeWebClient({
      conversations: { info: jest.fn().mockRejectedValue(new Error('no')) },
    });
    expect(await getChannelName(client, 'C123')).toBe('C123');
  });

  it('returns null permalink on error', async () => {
    const client = makeWebClient({
      chat: { getPermalink: jest.fn().mockRejectedValue(new Error('boom')) },
    });
    expect(await getMessagePermalink(client, 'C1', '1.1')).toBeNull();
  });

  it('startStream returns the streaming ts', async () => {
    const client = makeWebClient({
      chat: { startStream: jest.fn().mockResolvedValue({ ok: true, ts: '999.1' }) },
    });
    const ts = await startStream(client, { channel: 'D1', threadTs: '170.0' });
    expect(ts).toBe('999.1');
  });

  it('startStream throws when Slack omits ts', async () => {
    const client = makeWebClient({
      chat: { startStream: jest.fn().mockResolvedValue({ ok: true }) },
    });
    await expect(
      startStream(client, { channel: 'D1', threadTs: '170.0' })
    ).rejects.toThrow(/missing ts/);
  });

  it('appendStream returns closed when Slack signals not-in-streaming-state', async () => {
    const err = Object.assign(new Error('slack error'), {
      data: { error: 'message_not_in_streaming_state' },
    });
    const client = makeWebClient({
      chat: { appendStream: jest.fn().mockRejectedValue(err) },
    });
    const result = await appendStream(client, { channel: 'D1', ts: '1', markdownText: 'x' });
    expect(result).toEqual({ kind: 'closed' });
  });

  it('appendStream propagates other errors', async () => {
    const client = makeWebClient({
      chat: { appendStream: jest.fn().mockRejectedValue(new Error('boom')) },
    });
    await expect(
      appendStream(client, { channel: 'D1', ts: '1', markdownText: 'x' })
    ).rejects.toThrow('boom');
  });

  it('stopStream swallows not-in-streaming-state errors', async () => {
    const err = Object.assign(new Error('slack error'), {
      data: { error: 'message_not_in_streaming_state' },
    });
    const stopStreamSpy = jest.fn().mockRejectedValue(err);
    const client = makeWebClient({ chat: { stopStream: stopStreamSpy } });
    await expect(stopStream(client, { channel: 'D1', ts: '1' })).resolves.toBeUndefined();
    expect(stopStreamSpy).toHaveBeenCalled();
  });

  it('fetchImageHead returns null for non-2xx responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 404 }));
    const head = await fetchImageHead({
      url: 'https://files.slack.com/x.png',
      botToken: 'xoxb',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(head).toBeNull();
  });

  it('fetchImageHead parses content-type and content-length', async () => {
    const headers = new Headers({ 'Content-Type': 'image/png', 'Content-Length': '12345' });
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 200, headers }));
    const head = await fetchImageHead({
      url: 'https://files.slack.com/x.png',
      botToken: 'xoxb',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(head).toEqual({ contentType: 'image/png', contentLength: 12345 });
  });

  it('downloadImageBytes refuses zero max', async () => {
    await expect(
      downloadImageBytes({ url: 'x', botToken: 'y', maxBytes: 0 })
    ).rejects.toThrow(/maxBytes must be/);
  });

  it('downloadImageBytes enforces the size cap via header', async () => {
    const headers = new Headers({ 'Content-Length': '999999' });
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 200, headers }));
    await expect(
      downloadImageBytes({
        url: 'x',
        botToken: 'y',
        maxBytes: 100,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(/too large to inline/);
  });

  it('downloadImageBytes returns the buffer on success', async () => {
    const buf = new Uint8Array([0, 1, 2, 3]);
    const fetchImpl = jest.fn().mockResolvedValue(new Response(buf, { status: 200 }));
    const got = await downloadImageBytes({
      url: 'x',
      botToken: 'y',
      maxBytes: 1024,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(got).toEqual(buf);
  });

  it('pickFileDownloadUrl prefers urlPrivateDownload then urlPrivate', () => {
    expect(
      pickFileDownloadUrl({ urlPrivateDownload: 'a', urlPrivate: 'b', mimeType: null })
    ).toBe('a');
    expect(pickFileDownloadUrl({ urlPrivateDownload: null, urlPrivate: 'b', mimeType: null })).toBe('b');
    expect(pickFileDownloadUrl({ urlPrivateDownload: null, urlPrivate: null, mimeType: null })).toBeNull();
  });

  it('isMessageNotInStreamingStateError handles WebApiError shape', () => {
    expect(
      isMessageNotInStreamingStateError({ data: { error: 'message_not_in_streaming_state' } })
    ).toBe(true);
    expect(
      isMessageNotInStreamingStateError(new Error('something else: message_not_in_streaming_state'))
    ).toBe(true);
    expect(isMessageNotInStreamingStateError(new Error('other'))).toBe(false);
    expect(isMessageNotInStreamingStateError(null)).toBe(false);
  });
});
