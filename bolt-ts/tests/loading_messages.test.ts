import { buildSummarizeLoadingMessages } from '../src/loading_messages';

describe('buildSummarizeLoadingMessages', () => {
  it('returns <= 10 messages and includes the message count', () => {
    const messages = buildSummarizeLoadingMessages({ messageCount: 50, hasCustomStyle: false });

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.length).toBeLessThanOrEqual(10);
    expect(messages[0]).toContain('50');
  });

  it('includes a custom style hint when enabled', () => {
    const messages = buildSummarizeLoadingMessages({ messageCount: 25, hasCustomStyle: true });

    expect(messages.join('\n')).toContain('custom style');
  });
});


