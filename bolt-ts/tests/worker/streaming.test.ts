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
