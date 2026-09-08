import { extractSummaryBody } from '../../src/slack/summary_body';
import { sanitizeGeneratedSlackMrkdwn } from '../../src/slack/sanitize';

const receipt = 'https://3kingdomgroup.slack.com/archives/C012345678/p1788827400000002';
const footer = [
  { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Shorter' }, accessibility_label: 'Shorter using the same channel and time window' }] },
  { type: 'context', elements: [{ type: 'mrkdwn', text: 'AI-generated · 12:30' }] },
  { type: 'context_actions', elements: [{ type: 'feedback_buttons' }] },
];
const text = (value: string, style?: Record<string, boolean>) => ({ type: 'text', text: value, ...(style ? { style } : {}) });
const section = (elements: unknown[]) => ({ type: 'rich_text_section', elements });

describe('extractSummaryBody', () => {
  it('recovers streamed rich_text blocks rather than the accessibility transcript', () => {
    const body = extractSummaryBody({
      text: 'Summary of testing-bots. Shorter using the same channel and time window button Roast button AI-generated This message contains interactive elements.',
      blocks: [{ type: 'rich_text', elements: [
        section([text('Summary of #testing-bots', { bold: true })]),
        section([text('Alice moved the picnic to '), text('Friday', { bold: true }), text('. '), { type: 'link', url: receipt, text: 'The new date' }]),
      ] }, ...footer],
    });
    expect(body).toBe(`**Summary of #testing-bots**\n\nAlice moved the picnic to **Friday**. [The new date](${receipt})`);
    expect(body).not.toMatch(/Shorter|button|AI-generated|interactive elements/);
  });

  it('joins all Markdown recap blocks and excludes footer/control sections', () => {
    expect(extractSummaryBody({ text: 'bad fallback', blocks: [
      { type: 'markdown', text: 'First paragraph.' }, { type: 'markdown', text: `Read [the source](${receipt}).` },
      ...footer, { type: 'section', text: { type: 'mrkdwn', text: 'More footer copy' } },
    ] })).toBe(`First paragraph.\n\nRead [the source](${receipt}).`);
  });

  it('retains lists, indent, quotes, inline style, and fenced code without interpreting text as formatting', () => {
    expect(extractSummaryBody({ blocks: [{ type: 'rich_text', elements: [
      { type: 'rich_text_list', style: 'ordered', indent: 1, offset: 2, elements: [section([text('First *literal* item')]), section([text('Second', { italic: true, strike: true })])] },
      { type: 'rich_text_quote', elements: [text('A quote\nand another line')] },
      { type: 'rich_text_preformatted', elements: [text('const fence = ```;')] },
      section([text('code`span', { code: true })]),
    ] }] })).toBe('    3. First \\*literal\\* item\n    4. _~~Second~~_\n\n> A quote\n> and another line\n\n````\nconst fence = ```;\n````\n\n``code`span``');
  });

  it('preserves identity tokens and lets the existing delivery sanitizer suppress notifications', () => {
    const body = extractSummaryBody({ blocks: [{ type: 'rich_text', elements: [section([
      { type: 'user', user_id: 'U012345678' }, text(' in '), { type: 'channel', channel_id: 'C012345678' },
      text(' '), { type: 'usergroup', usergroup_id: 'S012345678' }, text(' '), { type: 'broadcast', range: 'here' },
      text(' '), { type: 'emoji', name: 'wave', unicode: '1f44b' },
    ])] }] });
    expect(body).toBe('<@U012345678> in <#C012345678> <!subteam^S012345678> <!here> 👋');
    expect(sanitizeGeneratedSlackMrkdwn(body)).toBe('`<@U012345678>` in <#C012345678> `<!subteam^S012345678>` `<!here>` 👋');
  });

  it('preserves link labels/destinations without allowing Markdown URL or label breakout', () => {
    const body = extractSummaryBody({ blocks: [{ type: 'rich_text', elements: [section([
      { type: 'link', url: 'https://example.com/a_(b)?q=hello world', text: 'a [source]' },
      text(' '), { type: 'link', url: 'javascript:alert(1)', text: 'unsafe link' },
    ])] }] });
    expect(body).toBe('[a \\[source\\]](https://example.com/a_%28b%29?q=hello%20world) unsafe link');
  });

  it('converts pure mrkdwn recap sections while preserving code and Slack links', () => {
    expect(extractSummaryBody({ blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*Friday* with ~Thursday~ replaced. <${receipt}|The date> and \`*literal*\`.` } },
      ...footer,
    ] })).toBe(`**Friday** with ~~Thursday~~ replaced. [The date](${receipt}) and \`*literal*\`.`);
  });

  it.each([
    [...footer],
    [{ type: 'section', text: { type: 'plain_text', text: 'Set style' }, accessory: { type: 'button' } }],
    [{ type: 'rich_text', elements: [section([{ type: 'unknown_future_element', text: 'Do not lose this fact' }])] }],
    [{ type: 'table', rows: [] }],
    [{ type: 'rich_text', elements: [{ type: 'rich_text_list', style: ['bullet'], elements: [] }] }],
  ].map((blocks) => ({ blocks })))('refuses missing or unsupported structured recap instead of copying fallback text %#', ({ blocks }) => {
    expect(extractSummaryBody({ text: 'This message contains interactive elements', blocks })).toBe('');
  });

  it('retains legacy genuinely text-only summaries', () => {
    expect(extractSummaryBody({ text: '  A legacy recap.  ' })).toBe('A legacy recap.');
    expect(extractSummaryBody({ text: 'A legacy recap.', blocks: [] })).toBe('A legacy recap.');
  });
});
