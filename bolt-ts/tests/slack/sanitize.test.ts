import { sanitizeGeneratedSlackMrkdwn } from '../../src/slack/sanitize';

describe('sanitizeGeneratedSlackMrkdwn', () => {
  it('wraps broadcast, user-group, and user mentions in code spans', () => {
    const text = 'Ping <!channel>, <!subteam^S123|ops>, and <@U123ABC456>';
    expect(sanitizeGeneratedSlackMrkdwn(text)).toBe(
      'Ping `<!channel>`, `<!subteam^S123|ops>`, and `<@U123ABC456>`'
    );
  });

  it('leaves regular links alone', () => {
    expect(sanitizeGeneratedSlackMrkdwn('<https://example.com|Example>')).toBe(
      '<https://example.com|Example>'
    );
  });

  it('handles workspace W-prefix user IDs', () => {
    expect(sanitizeGeneratedSlackMrkdwn('Hello <@W987654321>')).toBe(
      'Hello `<@W987654321>`'
    );
  });
});
