import { buildStreamPrefix } from '../../src/worker/streaming';

describe('buildStreamPrefix', () => {
  it('includes only the channel header when no style is set', () => {
    expect(buildStreamPrefix('C123', null)).toBe('*Summary from <#C123>*\n\n');
  });

  it('prepends a style header when set', () => {
    const prefix = buildStreamPrefix('C123', 'be cool');
    expect(prefix).toBe('_Style: be cool_\n\n*Summary from <#C123>*\n\n');
  });

  it('truncates long style headers to 60 chars + ellipsis', () => {
    const long = 'x'.repeat(120);
    const prefix = buildStreamPrefix('C123', long);
    expect(prefix.startsWith('_Style: ')).toBe(true);
    // Style portion = 57 chars + "..." == 60
    const styleSegment = prefix.split('_Style: ')[1].split('_\n\n')[0];
    expect([...styleSegment].length).toBe(60);
    expect(styleSegment.endsWith('...')).toBe(true);
  });

  it('drops empty/whitespace styles', () => {
    expect(buildStreamPrefix('C1', '   ')).toBe('*Summary from <#C1>*\n\n');
  });
});
