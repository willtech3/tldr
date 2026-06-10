import { buildStreamPrefix, buildBotNotInChannelMessage, buildEmptyChannelMessage } from '../../src/worker/streaming';

describe('buildStreamPrefix', () => {
  it('includes only the channel header when no style is set', () => {
    expect(buildStreamPrefix('general', null)).toBe('**Summary of #general**\n\n');
  });

  it('prepends a style header when set', () => {
    const prefix = buildStreamPrefix('general', 'be cool');
    expect(prefix).toBe('_Style: be cool_\n\n**Summary of #general**\n\n');
  });

  it('does not prepend # when the name lookup fell back to a channel ID', () => {
    expect(buildStreamPrefix('C123456789', null)).toBe('**Summary of C123456789**\n\n');
  });

  it('truncates long style headers to 60 chars + ellipsis', () => {
    const long = 'x'.repeat(120);
    const prefix = buildStreamPrefix('general', long);
    expect(prefix.startsWith('_Style: ')).toBe(true);
    // Style portion = 57 chars + "..." == 60
    const styleSegment = prefix.split('_Style: ')[1].split('_\n\n')[0];
    expect([...styleSegment].length).toBe(60);
    expect(styleSegment.endsWith('...')).toBe(true);
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
