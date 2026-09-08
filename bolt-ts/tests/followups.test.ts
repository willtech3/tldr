/**
 * Tests for post-summary follow-up prompts and thread retitling.
 */

import type { WebClient } from '@slack/web-api';
import { applyPostSummaryFollowUps, buildFollowUpPrompts, buildSourcePrompts } from '../src/followups';
import { parseUserIntent } from '../src/intent';
import { RECEIPTS_STYLE, ROAST_STYLE } from '../src/styles';

describe('buildSourcePrompts', () => {
  it('offers three distinct outcomes pinned to the selected source', () => {
    const prompts = buildSourcePrompts('C012345678');
    expect(prompts.map((prompt) => prompt.title)).toEqual(['Catch up', 'Roast', 'Receipts']);
    expect(prompts.map((prompt) => parseUserIntent(prompt.message))).toEqual([
      { type: 'summarize', targetChannel: 'C012345678', count: null, styleOverride: null },
      { type: 'summarize', targetChannel: 'C012345678', count: null, styleOverride: ROAST_STYLE },
      { type: 'summarize', targetChannel: 'C012345678', count: null, styleOverride: RECEIPTS_STYLE },
    ]);
  });

  it('offers only help until a source is selected', () => {
    expect(buildSourcePrompts(null)).toEqual([{ title: 'How to use TLDR', message: 'help' }]);
  });

  it('does not reuse another thread or source selection', () => {
    buildSourcePrompts('C099999999');
    expect(buildSourcePrompts('C012345678').every((prompt) => prompt.message.includes('<#C012345678>'))).toBe(true);
  });
});

describe('buildFollowUpPrompts', () => {
  it('offers only explicit latest-message requests, with no duplicate transforms', () => {
    expect(buildFollowUpPrompts('C012345678', 5)).toEqual([
      { title: 'Refresh latest 5', message: 'summarize <#C012345678> last 5' },
      { title: 'Expand to latest 200', message: 'summarize <#C012345678> last 200' },
    ]);
  });

  it.each([[50, 200], [199, 200], [200, 300], [250, 300], [300, 400], [499, 500]])(
    'expands %i to %i, always exceeding the current count', (count, expandedCount) => {
      const prompts = buildFollowUpPrompts('C012345678', count);
      expect(prompts[1]).toEqual({
        title: `Expand to latest ${expandedCount}`,
        message: `summarize <#C012345678> last ${expandedCount}`,
      });
    }
  );

  it('omits expansion at the maximum count', () => {
    expect(buildFollowUpPrompts('C012345678', 500)).toEqual([
      { title: 'Refresh latest 500', message: 'summarize <#C012345678> last 500' },
    ]);
  });

  it.each([1, 5, 50, 200, 500, 700, NaN, -1, 12.9])(
    'keeps count %p requests bounded and parseable for the original source', (count) => {
      for (const prompt of buildFollowUpPrompts('C012345678', count)) {
        const intent = parseUserIntent(prompt.message);
        expect(intent).toMatchObject({ type: 'summarize', targetChannel: 'C012345678', styleOverride: null });
        if (intent.type !== 'summarize') {
          throw new Error('Suggested prompt must request a summary');
        }
        expect(intent.count).toBeGreaterThanOrEqual(1);
        expect(intent.count).toBeLessThanOrEqual(500);
        expect(Number.isInteger(intent.count)).toBe(true);
      }
    }
  );
});

describe('applyPostSummaryFollowUps', () => {
  function makeClient(overrides: Partial<Record<string, jest.Mock>> = {}) {
    const setSuggestedPrompts =
      overrides.setSuggestedPrompts ?? jest.fn().mockResolvedValue({ ok: true });
    const setTitle = overrides.setTitle ?? jest.fn().mockResolvedValue({ ok: true });
    const conversationsInfo =
      overrides.conversationsInfo ?? jest.fn().mockResolvedValue({ channel: { name: 'general' } });
    const client = {
      assistant: { threads: { setSuggestedPrompts, setTitle } },
      conversations: { info: conversationsInfo },
    } as unknown as WebClient;
    return { client, setSuggestedPrompts, setTitle, conversationsInfo };
  }

  it('refreshes prompts and retitles the thread after the source channel', async () => {
    const { client, setSuggestedPrompts, setTitle } = makeClient();

    await applyPostSummaryFollowUps({
      client,
      assistantChannelId: 'D1',
      assistantThreadTs: '1.0',
      sourceChannelId: 'C123',
      messageCount: 75,
      style: null,
    });

    expect(setSuggestedPrompts).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'D1',
        thread_ts: '1.0',
        title: 'Get the latest',
        prompts: [
          { title: 'Refresh latest 75', message: 'summarize <#C123> last 75' },
          { title: 'Expand to latest 200', message: 'summarize <#C123> last 200' },
        ],
      })
    );
    expect(setTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'D1',
        thread_ts: '1.0',
        title: 'TLDR — #general',
      })
    );
  });

  it('never throws when Slack rejects the calls', async () => {
    const warn = jest.fn();
    const { client } = makeClient({
      setSuggestedPrompts: jest.fn().mockRejectedValue(new Error('nope')),
      setTitle: jest.fn().mockRejectedValue(new Error('nope')),
    });

    await expect(
      applyPostSummaryFollowUps({
        client,
        assistantChannelId: 'D1',
        assistantThreadTs: '1.0',
        sourceChannelId: 'C123',
        messageCount: 75,
        style: null,
        logger: { warn },
      })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
