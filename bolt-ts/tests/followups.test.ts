/**
 * Tests for post-summary follow-up prompts and thread retitling.
 */

import type { WebClient } from '@slack/web-api';
import { applyPostSummaryFollowUps, buildFollowUpPrompts } from '../src/followups';
import { RECEIPTS_STYLE, ROAST_STYLE } from '../src/styles';

describe('buildFollowUpPrompts', () => {
  it('offers roast and receipts after a default summary', () => {
    const titles = buildFollowUpPrompts(null).map((p) => p.title);
    expect(titles.some((t) => t.includes('Roast'))).toBe(true);
    expect(titles.some((t) => t.includes('receipts'))).toBe(true);
  });

  it('drops the roast prompt after a roast summary', () => {
    const titles = buildFollowUpPrompts(ROAST_STYLE).map((p) => p.title);
    expect(titles.some((t) => t.includes('Roast'))).toBe(false);
  });

  it('drops the receipts prompt after a receipts summary', () => {
    const titles = buildFollowUpPrompts(RECEIPTS_STYLE).map((p) => p.title);
    expect(titles.some((t) => t.includes('receipts'))).toBe(false);
  });

  it('never exceeds Slack limit of 4 prompts', () => {
    expect(buildFollowUpPrompts(null).length).toBeLessThanOrEqual(4);
    expect(buildFollowUpPrompts('be funny').length).toBeLessThanOrEqual(4);
  });

  it('produces messages that round-trip through a summarize command', () => {
    for (const prompt of buildFollowUpPrompts(null)) {
      expect(prompt.message.startsWith('summarize')).toBe(true);
    }
  });
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
      style: null,
    });

    expect(setSuggestedPrompts).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'D1',
        thread_ts: '1.0',
        prompts: expect.any(Array),
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
        style: null,
        logger: { warn },
      })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
