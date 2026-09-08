import { buildSummaryLatestMenu, parseSummaryLatestValue } from '../src/summary_latest';
import { STYLE_PRESETS } from '../src/styles';

const request = { v: 1, action: 'refresh_latest', channelId: 'C012345678', count: 5, styleKey: 'default' };
const input = { sourceChannelId: request.channelId, sourceChannelName: 'testing-bots', messageCount: 5, currentStyle: null };

describe('explicit latest-message menu', () => {
  it('offers fresh requests for the original source, requested count, and explicit Default style', () => {
    const menu = buildSummaryLatestMenu(input)!;
    expect(menu.type).toBe('overflow');
    expect(menu.options.map((option) => option.text?.text)).toEqual(['Refresh latest 5 · Default', 'Expand to latest 200 · Default']);
    expect(menu.options.map((option) => JSON.parse(option.value!))).toEqual([
      request, { ...request, action: 'expand_latest', count: 200 },
    ]);
    expect(menu.options.every((option) => option.description?.text === 'Latest messages in #testing-bots')).toBe(true);
    expect(menu).not.toHaveProperty('accessibility_label');
  });

  it.each([[1, 200], [50, 200], [199, 200], [200, 300], [250, 300], [499, 500]])(
    'expands %i to %i, always requesting more while bounded at 500', (count, expanded) => {
      const menu = buildSummaryLatestMenu({ ...input, messageCount: count })!;
      expect(parseSummaryLatestValue(menu.options[1].value)?.count).toBe(expanded);
    }
  );

  it('offers only refresh at the maximum count', () => {
    const menu = buildSummaryLatestMenu({ ...input, messageCount: 500 })!;
    expect(menu.options).toHaveLength(1);
    expect(parseSummaryLatestValue(menu.options[0].value)?.count).toBe(500);
  });

  it.each(STYLE_PRESETS)('carries only canonical preset identity for $key', (preset) => {
    const menu = buildSummaryLatestMenu({ ...input, currentStyle: preset.value })!;
    for (const option of menu.options) {
      expect(parseSummaryLatestValue(option.value)?.styleKey).toBe(preset.key);
      expect(option.value).not.toContain(preset.value);
      expect(option.value!.length).toBeLessThanOrEqual(150);
      expect(option.text!.text.length).toBeLessThanOrEqual(75);
    }
  });

  it('makes Default explicit for arbitrary instructions and never exposes them', () => {
    const privateStyle = 'Private instructions: roast my family gently.';
    const menu = buildSummaryLatestMenu({ ...input, currentStyle: privateStyle })!;
    expect(JSON.stringify(menu)).not.toContain(privateStyle);
    expect(menu.options.every((option) => option.text?.text.endsWith('· Default'))).toBe(true);
    expect(menu.options.every((option) => parseSummaryLatestValue(option.value)?.styleKey === 'default')).toBe(true);
  });

  it('bounds long channel labels and declines IDs that cannot fit Slack option values', () => {
    const menu = buildSummaryLatestMenu({ ...input, sourceChannelName: 'x'.repeat(80) })!;
    expect(menu.options.every((option) => option.description!.text.length <= 75)).toBe(true);
    expect(buildSummaryLatestMenu({ ...input, sourceChannelId: 'C' + '1'.repeat(150) })).toBeNull();
  });

  it.each([0, -1, 1.5, 501, NaN, Infinity])('does not create a fresh request by normalizing invalid count %p', (count) => {
    expect(buildSummaryLatestMenu({ ...input, messageCount: count })).toBeNull();
  });
});

describe('latest-message payload boundary', () => {
  it.each([
    null, {}, [], { ...request, v: 2 }, { ...request, action: 'rerun_shorter' },
    { ...request, action: ['refresh_latest'] }, { ...request, channelId: 'bad' },
    { ...request, channelId: 123456789 }, { ...request, count: 0 },
    { ...request, count: 501 }, { ...request, count: '5' }, { ...request, count: 1.5 },
    { ...request, styleKey: 'custom' }, { ...request, styleKey: '__default__' },
    { ...request, styleKey: 'unknown' }, { ...request, window: null },
    { ...request, customStyle: 'secret' }, { ...request, summaryToShorten: 'old recap' },
  ])('rejects malformed or unsupported saved data: case %#', (value) => {
    expect(parseSummaryLatestValue(JSON.stringify(value))).toBeNull();
  });
  it('bounds parsing and accepts only serialized menu values', () => {
    expect(parseSummaryLatestValue(request)).toBeNull();
    expect(parseSummaryLatestValue('{')).toBeNull();
    expect(parseSummaryLatestValue('x'.repeat(151))).toBeNull();
    expect(parseSummaryLatestValue(JSON.stringify(request))).toEqual(request);
  });
});
