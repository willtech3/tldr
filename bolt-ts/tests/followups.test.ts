/**
 * Tests for post-summary follow-up prompts and thread retitling.
 */

import type { WebClient } from '@slack/web-api';
import { applyPostSummaryFollowUps, buildSourcePrompts } from '../src/followups';
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

  it('retitles the source thread without replacing initial suggested prompts', async () => {
    const { client, setSuggestedPrompts, setTitle } = makeClient();

    await applyPostSummaryFollowUps({
      client,
      assistantChannelId: 'D1',
      assistantThreadTs: '1.0',
      sourceChannelId: 'C123',
    });

    expect(setSuggestedPrompts).not.toHaveBeenCalled();
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
        logger: { warn },
      })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
