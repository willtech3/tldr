import {
  MAX_CUSTOM_STYLE_LENGTH,
  buildPrompt,
  sanitizeCustomInternal,
  type BuildPromptArgs,
} from '../../src/ai/prompt';

function baseArgs(overrides: Partial<BuildPromptArgs> = {}): BuildPromptArgs {
  return {
    channelName: 'general',
    formattedMessages: ['[170.0001] alice: hello world'],
    linksShared: [],
    receipts: [],
    images: [],
    customStyle: null,
    ...overrides,
  };
}

describe('sanitizeCustomInternal', () => {
  it('passes through ordinary text', () => {
    expect(sanitizeCustomInternal('be hyper-critical and funny')).toBe(
      'be hyper-critical and funny'
    );
  });

  it('strips control characters but preserves regular spaces', () => {
    const dirty = ['clean', String.fromCharCode(9), ' text'].join('');
    expect(sanitizeCustomInternal(dirty)).toBe('clean text');
  });

  it('strips NULL and other C0/C1 control characters', () => {
    const dirty = ['a', String.fromCharCode(0), 'b', String.fromCharCode(0x1f), 'c'].join('');
    expect(sanitizeCustomInternal(dirty)).toBe('abc');
  });

  it('hard-truncates to the max length', () => {
    const long = 'a'.repeat(MAX_CUSTOM_STYLE_LENGTH + 50);
    expect(sanitizeCustomInternal(long)).toHaveLength(MAX_CUSTOM_STYLE_LENGTH);
  });

  it('preserves multibyte characters when truncating', () => {
    const emojiBlock = '🎉'.repeat(MAX_CUSTOM_STYLE_LENGTH + 5);
    const sanitized = sanitizeCustomInternal(emojiBlock);
    expect(Array.from(sanitized)).toHaveLength(MAX_CUSTOM_STYLE_LENGTH);
  });
});

describe('buildPrompt', () => {
  it('emits a TLDR-bot system prompt with rule + output_format + example XML blocks', () => {
    const payload = buildPrompt(baseArgs());
    expect(payload.system).toContain('You are TLDR-bot');
    expect(payload.system).toContain('<rules>');
    expect(payload.system).toContain('<output_format>');
    expect(payload.system).toContain('<example>');
    expect(payload.system).toContain('*Summary*');
    expect(payload.system).toContain('*Receipts*');
  });

  it('wraps channel name and messages in XML tags', () => {
    const payload = buildPrompt(baseArgs({ channelName: 'demo' }));
    const text = (payload.userContent[0] as { text: string }).text;
    expect(text).toContain('<channel>\ndemo\n</channel>');
    expect(text).toContain('<messages>\n[170.0001] alice: hello world\n</messages>');
    expect(text).toContain('<task>');
  });

  it('includes links and receipts blocks', () => {
    const payload = buildPrompt(
      baseArgs({
        linksShared: ['https://example.com/a', 'https://example.com/b'],
        receipts: [
          { permalink: 'https://slack.test/p1', author: 'alice', snippet: 'hello' },
          { permalink: 'https://slack.test/p2', author: 'bob', snippet: '' },
        ],
      })
    );
    const text = (payload.userContent[0] as { text: string }).text;
    expect(text).toContain('<links_shared>');
    expect(text).toContain('- https://example.com/a');
    expect(text).toContain('<receipts>');
    expect(text).toContain('https://slack.test/p1 — alice: "hello"');
    expect(text).toContain('https://slack.test/p2 — bob');
  });

  it('does not include a custom_style block when none provided', () => {
    const payload = buildPrompt(baseArgs());
    const text = (payload.userContent[0] as { text: string }).text;
    expect(text).not.toContain('<custom_style>');
  });

  it('embeds sanitised custom style when provided', () => {
    const dirty = `roast everyone${String.fromCharCode(9)}`;
    const payload = buildPrompt(baseArgs({ customStyle: dirty }));
    const text = (payload.userContent[0] as { text: string }).text;
    expect(text).toContain('<custom_style>\nroast everyone\n</custom_style>');
    expect(text).not.toContain(String.fromCharCode(9));
    expect(text).toContain('Apply the tone and voice in the <custom_style>');
  });

  it('places images between the channel context and the task block', () => {
    const fakeImage = {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: 'AAAA',
      },
    };
    const payload = buildPrompt(baseArgs({ images: [fakeImage] }));
    expect(payload.userContent.length).toBe(3);
    expect(payload.userContent[0].type).toBe('text');
    expect(payload.userContent[1]).toEqual(fakeImage);
    expect(payload.userContent[2].type).toBe('text');
    expect((payload.userContent[2] as { text: string }).text).toContain('<task>');
  });

  it('escapes < and > inside channel/messages to keep XML framing safe', () => {
    const payload = buildPrompt(
      baseArgs({
        channelName: 'demo<script>',
        formattedMessages: ['[170.0001] alice: pwn <script>'],
      })
    );
    const text = (payload.userContent[0] as { text: string }).text;
    expect(text).toContain('demo&lt;script&gt;');
    expect(text).toContain('pwn &lt;script&gt;');
  });

  it('caps embedded custom style at MAX_CUSTOM_STYLE_LENGTH codepoints', () => {
    const long = 'x'.repeat(MAX_CUSTOM_STYLE_LENGTH + 200);
    const payload = buildPrompt(baseArgs({ customStyle: long }));
    const text = (payload.userContent[0] as { text: string }).text;
    const block = text.split('<custom_style>\n')[1].split('\n</custom_style>')[0];
    expect([...block]).toHaveLength(MAX_CUSTOM_STYLE_LENGTH);
  });
});
