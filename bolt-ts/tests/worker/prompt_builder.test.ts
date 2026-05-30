import type { WebClient } from '@slack/web-api';
import {
  applySafetyNetSections,
  buildSummarizePromptData,
} from '../../src/worker/prompt_builder';

describe('applySafetyNetSections', () => {
  it('appends Links shared, Image highlights, and Receipts when missing', () => {
    const result = applySafetyNetSections('*Summary*\nThings happened.', {
      linksShared: [],
      receiptPermalinks: [],
      hasAnyImages: false,
    });
    expect(result).toContain('*Links shared*');
    expect(result).toContain('*Image highlights*');
    expect(result).toContain('*Receipts*');
    expect(result).toContain('- None');
  });

  it('does not duplicate sections already present in the summary', () => {
    const summary = '*Summary*\nfoo\n*Links shared*\n- existing\n*Image highlights*\n- existing\n*Receipts*\n- existing';
    const result = applySafetyNetSections(summary, {
      linksShared: ['https://shouldnotappear.example'],
      receiptPermalinks: ['https://shouldnotappear.example'],
      hasAnyImages: true,
    });
    expect(result).toBe(summary);
  });

  it('inserts known links and receipts when sections are missing', () => {
    const result = applySafetyNetSections('*Summary*\nthings.', {
      linksShared: ['https://example.com'],
      receiptPermalinks: ['https://slack.example/archives/C/p1'],
      hasAnyImages: true,
    });
    expect(result).toContain('- https://example.com');
    expect(result).toContain('- https://slack.example/archives/C/p1');
    expect(result).toContain('- (No image highlights provided.)');
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
    // HEAD + GET for each of the two images.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
