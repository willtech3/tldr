import type { WebClient } from '@slack/web-api';
import {
  applySafetyNetSections,
  buildSummarizePromptData,
} from '../../src/worker/prompt_builder';

describe('applySafetyNetSections', () => {
  it('leaves a small recap alone when there are no receipts', () => {
    expect(applySafetyNetSections('A quiet exchange about lunch.', { receipts: [] }))
      .toBe('A quiet exchange about lunch.');
  });

  it('does not duplicate sources already linked inline', () => {
    const summary = 'Alice [confirmed Friday](https://slack.example/p1).';
    expect(applySafetyNetSections(summary, {
      receipts: [{ permalink: 'https://slack.example/p1', author: 'Alice', snippet: 'Friday works' }],
    })).toBe(summary);
  });

  it('adds at most three contextual source links without empty inventories', () => {
    const result = applySafetyNetSections('Friday works for everyone.', {
      receipts: Array.from({ length: 8 }, (_, index) => ({
        permalink: `https://slack.example/p${index}`, author: 'Alice', snippet: `Friday works ${index}`,
      })),
    });
    expect(result).toContain('[Alice: Friday works 0](https://slack.example/p0)');
    expect(result.match(/https:/g)).toHaveLength(3);
    expect(result).not.toMatch(/Links shared|Image highlights|None/);
  });

  it('keeps untrusted source text inside the label and escapes link delimiters', () => {
    const result = applySafetyNetSections('An update.', {
      receipts: [{
        permalink: 'https://slack.example/p(1)', author: '<!channel>',
        snippet: 'look](https://evil.example) [now',
      }],
    });
    expect(result).toContain('&lt;!channel&gt;');
    expect(result).not.toContain('<!channel>');
    expect(result).toContain('look\\](https://evil.example) \\[now');
    expect(result).toContain('](https://slack.example/p%281%29)');
  });
});

describe('buildSummarizePromptData inline images', () => {
  it('downloads multiple images in parallel and emits them as content blocks', async () => {
    const client = {
      conversations: { info: jest.fn().mockResolvedValue({ channel: { name: 'general' } }) },
      users: { info: jest.fn().mockResolvedValue({ user: { profile: { display_name: 'bob' } } }) },
      chat: { getPermalink: jest.fn().mockResolvedValue({ permalink: 'https://x.test/p' }) },
    } as unknown as WebClient;

    // HEAD → image metadata; GET → bytes. One of each per image.
    const fetchImpl = jest.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': '1024' },
        });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-length': '4' },
      });
    });

    const messages = [
      {
        ts: '100',
        user: 'U1',
        text: 'pic one',
        files: [{ urlPrivateDownload: 'https://files/1', urlPrivate: null, mimeType: 'image/png' }],
      },
      {
        ts: '101',
        user: 'U2',
        text: 'pic two',
        files: [{ urlPrivateDownload: 'https://files/2', urlPrivate: null, mimeType: 'image/jpeg' }],
      },
    ];

    const out = await buildSummarizePromptData({
      client,
      botToken: 'xoxb',
      channelId: 'C1',
      messages,
      customStyle: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(out.hasAnyImages).toBe(true);
    const imageBlocks = out.prompt.userContent.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(2);
    const imageIndexes = out.prompt.userContent.flatMap((block, index) => block.type === 'image' ? [index] : []);
    expect(out.prompt.userContent[imageIndexes[0] - 1]).toEqual(expect.objectContaining({
      text: expect.stringContaining('[100] bob — https://x.test/p'),
    }));
    expect(out.prompt.userContent[imageIndexes[1] - 1]).toEqual(expect.objectContaining({
      text: expect.stringContaining('[101] bob — https://x.test/p'),
    }));
    // HEAD + GET for each of the two images.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});


describe('source selection and coverage', () => {
  const makeMessage = (ts: string, text: string) => ({ ts, text, user: 'U1', files: [] });
  const makeClient = () => ({
    conversations: { info: jest.fn().mockResolvedValue({ channel: { name: 'testing-bots' } }) },
    users: { info: jest.fn().mockResolvedValue({ user: { profile: { display_name: 'Alice' } } }) },
    chat: { getPermalink: jest.fn(async ({ message_ts }: { message_ts: string }) => ({ permalink: `https://slack.example/p${message_ts}` })) },
  });

  it('retains text-only sources even when a different message shares a link', async () => {
    const client = makeClient();
    const messages = [makeMessage('100', 'https://example.com'), ...Array.from({ length: 19 }, (_, index) => makeMessage(String(101 + index), `Plan ${index}`))];
    const out = await buildSummarizePromptData({ client: client as unknown as WebClient, botToken: 'x', channelId: 'C1', messages, customStyle: null });
    expect(out.receipts.some((receipt) => receipt.snippet === 'https://example.com')).toBe(true);
    expect(out.receipts.some((receipt) => receipt.snippet === 'Plan 18')).toBe(true);
    expect(client.chat.getPermalink).toHaveBeenCalledTimes(12);
    expect(out.coverage).toEqual({ messageCount: 20, oldestTs: '100', latestTs: '119' });
  });

  it('labels image-only messages without fabricating a caption or quote', async () => {
    const client = makeClient();
    const out = await buildSummarizePromptData({
      client: client as unknown as WebClient, botToken: 'x', channelId: 'C1', customStyle: null,
      messages: [{ ts: '100', user: 'U1', text: '', files: [{ mimeType: 'image/png', urlPrivate: null, urlPrivateDownload: null }] }],
    });
    expect(out.receipts[0]).toMatchObject({ author: 'Alice', snippet: 'shared an image', attachmentOnly: true });
    expect(out.prompt.userContent[0]).toEqual(expect.objectContaining({ text: expect.stringContaining('attachment description, not a quote') }));
    expect(applySafetyNetSections('Alice shared a photo.', out)).toContain('[Alice: shared an image]');
  });

  it('does not invent a date span when a supplied timestamp is malformed', async () => {
    const out = await buildSummarizePromptData({
      client: makeClient() as unknown as WebClient, botToken: 'x', channelId: 'C1', customStyle: null,
      messages: [makeMessage('bad', 'one'), makeMessage('100', 'two')],
    });
    expect(out.coverage).toEqual({ messageCount: 2, oldestTs: null, latestTs: null });
  });
});
