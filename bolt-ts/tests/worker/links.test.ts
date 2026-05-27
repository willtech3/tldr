import {
  extractLinksFromMessage,
  extractLinksFromMessages,
  extractLinksFromText,
  normaliseAndDedupe,
} from '../../src/worker/links';

describe('extractLinksFromText', () => {
  it('captures Slack-link markup and raw URLs', () => {
    const text = 'See <https://www.example.com|example> and also https://foo.bar/baz).';
    const links = extractLinksFromText(text);
    expect(links).toContain('https://www.example.com');
    expect(links).toContain('https://foo.bar/baz');
  });

  it('returns an empty array for plain text', () => {
    expect(extractLinksFromText('no links here')).toEqual([]);
  });
});

describe('extractLinksFromMessage', () => {
  it('reads URLs from blocks and attachments', () => {
    const msg = {
      text: '',
      blocks: [
        {
          type: 'rich_text',
          elements: [{ type: 'link', url: 'https://example.com/blocks' }],
        },
      ],
      attachments: [{ title_link: 'https://example.com/attach' }],
    };
    const links = extractLinksFromMessage(msg);
    expect(links).toEqual(
      expect.arrayContaining(['https://example.com/blocks', 'https://example.com/attach'])
    );
  });
});

describe('normaliseAndDedupe', () => {
  it('removes Slack permalinks and dedupes', () => {
    const links = normaliseAndDedupe([
      'https://example.com/a',
      'https://example.com/a',
      'https://acme.slack.com/archives/C123/p1234567890',
      'https://files.slack.com/files/x.png',
    ]);
    expect(links).toEqual(['https://example.com/a']);
  });

  it('strips trailing slashes and fragments', () => {
    expect(normaliseAndDedupe(['https://example.com/path/#section'])).toEqual([
      'https://example.com/path',
    ]);
  });

  it('rejects non-http URLs', () => {
    expect(normaliseAndDedupe(['mailto:foo@example.com', 'ftp://example.com'])).toEqual([]);
  });
});

describe('extractLinksFromMessages', () => {
  it('combines and dedupes across messages', () => {
    const messages = [
      { text: 'see https://example.com/a and <https://example.com/b|b>' },
      { text: 'https://example.com/a again' },
    ];
    const result = extractLinksFromMessages(messages);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining(['https://example.com/a', 'https://example.com/b']));
  });
});
