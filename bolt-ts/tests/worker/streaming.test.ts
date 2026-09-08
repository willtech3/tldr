import { buildStreamPrefix, buildBotNotInChannelMessage, buildEmptyChannelMessage } from '../../src/worker/streaming';

describe('buildStreamPrefix', () => {
  it('includes only the channel header when no style is set', () => {
    expect(buildStreamPrefix('general', null)).toBe('**Summary of #general**\n\n');
  });

  it('prepends a style header when set', () => {
    const prefix = buildStreamPrefix('general', 'be cool');
    expect(prefix).toBe('_Style: Custom_\n\n**Summary of #general**\n\n');
  });

  it('does not prepend # when the name lookup fell back to a channel ID', () => {
    expect(buildStreamPrefix('C123456789', null)).toBe('**Summary of C123456789**\n\n');
  });

  it('uses a short label without leaking custom style instructions into the title', () => {
    const prefix = buildStreamPrefix('general', 'x'.repeat(4000));
    expect(prefix).toBe('_Style: Custom_\n\n**Summary of #general**\n\n');
  });

  it('places the actual included count and covered dates before the recap', () => {
    const prefix = buildStreamPrefix('testing-bots', null, { messageCount: 3, oldestTs: '1788825600.000001', latestTs: '1788827400.000002' });
    expect(prefix).toContain('3 messages · Sep 8, 2026 · 00:00–00:30 UTC');
    expect(prefix).not.toContain('<!date');
  });

  it('drops empty/whitespace styles', () => {
    expect(buildStreamPrefix('eng', '   ')).toBe('**Summary of #eng**\n\n');
  });
});

describe('error copy builders', () => {
  it('tells the user how to fix bot-not-in-channel', () => {
    const message = buildBotNotInChannelMessage('C123456789');
    expect(message).toContain('<#C123456789>');
    expect(message).toContain('/invite @TLDR');
  });

  it('mentions the empty channel by reference', () => {
    expect(buildEmptyChannelMessage('C123456789')).toContain('<#C123456789>');
  });
});

import type { WebClient } from '@slack/web-api';
import { LlmClient } from '../../src/ai/anthropic';
import { streamSummaryToAssistantThread } from '../../src/worker/streaming';
import { extractSummaryBody } from '../../src/slack/summary_body';

function streamFixture(body = 'A recap for <!here>.') {
  const methods = {
    startStream: jest.fn().mockResolvedValue({ ts: '1788888888.000001' }),
    appendStream: jest.fn().mockResolvedValue({ ok: true }),
    stopStream: jest.fn().mockResolvedValue({ ok: true }),
    update: jest.fn().mockResolvedValue({ ok: true }),
    delete: jest.fn(), postMessage: jest.fn(), getPermalink: jest.fn().mockResolvedValue({ permalink: 'https://3kingdomgroup.slack.com/archives/C012345678/p1788827400000002' }),
  };
  const client = {
    chat: methods,
    auth: { test: jest.fn().mockResolvedValue({ user_id: 'UBOT' }) },
    conversations: {
      history: jest.fn().mockResolvedValue({ messages: [{ ts: '1788827400.000002', user: 'U012345678', text: 'A source message.' }] }),
      info: jest.fn().mockResolvedValue({ channel: { name: 'testing-bots' } }),
    },
    users: { info: jest.fn().mockResolvedValue({ user: { profile: { real_name: 'Alice' } } }) },
  } as unknown as WebClient;
  const llm = new LlmClient({ apiKey: 'test-only', model: 'test-only' });
  jest.spyOn(llm, 'generateSummaryStream').mockResolvedValue({
    kind: 'active', iterator: (async function* () { yield { kind: 'text_delta' as const, delta: body }; yield { kind: 'completed' as const }; })(),
    cancel: async () => {},
  });
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const args = { client, llm, logger, botToken: 'test-only', sourceChannelId: 'C012345678', assistantChannelId: 'D012345678',
    assistantThreadTs: '1788827400.000001', messageCount: 5, customStyle: 'Private one-off instructions.',
    correlationId: 'canonical-recap-test', streamMaxChunkChars: 4000, streamMinAppendIntervalMs: 0 };
  return { methods, logger, run: () => streamSummaryToAssistantThread(args, logger) };
}

describe('canonical streamed recap body', () => {
  it('sets the complete visible recap and safe fallback only after stream completion, keeping private instructions out of metadata', async () => {
    const f = streamFixture();
    expect(await f.run()).toBe('delivered');
    expect(f.methods.stopStream.mock.invocationCallOrder[0]).toBeLessThan(f.methods.update.mock.invocationCallOrder[0]);
    const updated = f.methods.update.mock.calls[0][0];
    expect(updated.channel).toBe('D012345678');
    expect(updated.ts).toBe('1788888888.000001');
    expect(updated.text).toContain('A recap for `<!here>`.');
    expect(extractSummaryBody(updated)).toContain('A recap for `<!here>`.');
    expect(extractSummaryBody(updated)).toContain('**Sources**');
    expect(updated.blocks[0].type).toBe('markdown');
    expect(updated.blocks[0].text).toContain('1 message');
    expect(updated.text).not.toMatch(/using the same channel|AI-generated|interactive elements/);
    expect(JSON.stringify(updated.metadata)).not.toContain('Private one-off instructions');
    expect(f.methods.postMessage).not.toHaveBeenCalled();
    expect(f.methods.delete).not.toHaveBeenCalled();
  });

  it('keeps the completed recap when Slack rejects normalization and does not log the failed payload', async () => {
    const f = streamFixture();
    f.methods.update.mockRejectedValue(new Error('block_mismatch with sensitive request body'));
    expect(await f.run()).toBe('delivered');
    expect(f.methods.update).toHaveBeenCalledTimes(1);
    expect(f.methods.postMessage).not.toHaveBeenCalled();
    expect(f.methods.delete).not.toHaveBeenCalled();
    expect(f.logger.error).not.toHaveBeenCalled();
    expect(f.logger.warn).toHaveBeenCalledWith('Delivered summary could not be normalized for follow-up actions');
  });

  it('does not rewrite a stream stopped by the user', async () => {
    const f = streamFixture();
    f.methods.appendStream.mockRejectedValue({ data: { error: 'message_not_in_streaming_state' } });
    expect(await f.run()).toBe('stopped');
    expect(f.methods.update).not.toHaveBeenCalled();
    expect(f.methods.postMessage).not.toHaveBeenCalled();
  });

  it('keeps a successfully delivered long recap without replacing it with a truncated Markdown block', async () => {
    const f = streamFixture('x'.repeat(13_000));
    expect(await f.run()).toBe('delivered');
    expect(f.methods.stopStream).toHaveBeenCalled();
    expect(f.methods.update).not.toHaveBeenCalled();
    expect(f.methods.postMessage).not.toHaveBeenCalled();
    expect(f.methods.delete).not.toHaveBeenCalled();
  });

  it('keeps a complete medium recap while bounding only its notification fallback', async () => {
    const f = streamFixture('x'.repeat(5000));
    expect(await f.run()).toBe('delivered');
    const updated = f.methods.update.mock.calls[0][0];
    expect(updated.text.length).toBe(4000);
    expect(updated.blocks[0].text).toContain('x'.repeat(5000));
    expect(updated.blocks[0].text).not.toContain('truncated');
  });
});
