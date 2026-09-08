import { isValidSummaryWindow, parseSummaryWindow } from '../src/summary_window';

describe('parseSummaryWindow', () => {
  it('preserves exact inclusive timestamps and drops unrelated fields', () => {
    const window = { oldestTs: '1788825600.000001', latestTs: '1788827400.000003' };
    expect(parseSummaryWindow({ ...window, unrelated: 'ignored' })).toEqual(window);
    expect(isValidSummaryWindow(window)).toBe(true);
  });

  it('accepts single-message and zero-time windows without float coercion', () => {
    expect(parseSummaryWindow({ oldestTs: '0.0', latestTs: '0.000000' })).not.toBeNull();
    expect(parseSummaryWindow({ oldestTs: '1788825600.1', latestTs: '1788825600.100000' })).not.toBeNull();
  });

  it('compares microseconds exactly even where JavaScript numbers collide', () => {
    expect(Number('999999999999.000002')).toBe(Number('999999999999.000001'));
    expect(parseSummaryWindow({ oldestTs: '999999999999.000002', latestTs: '999999999999.000001' })).toBeNull();
  });

  it.each([
    undefined, null, [], '1788825600.000001', {},
    { oldestTs: '1788825600.000001' },
    { oldestTs: 1788825600, latestTs: '1788827400.000003' },
    { oldestTs: '1788827400.000004', latestTs: '1788827400.000003' },
    ...['', '-1.0', '-0.0', '1', '1.', '.1', '1.1234567', '+1.0', '1e3', 'Infinity', 'NaN', ' 1.0', '1.0\n', '1000000000000.0'].map(
      (oldestTs) => ({ oldestTs, latestTs: '1788827400.000003' })
    ),
  ])('rejects invalid or unbounded input: %p', (input) => {
    expect(parseSummaryWindow(input)).toBeNull();
    expect(isValidSummaryWindow(input)).toBe(false);
  });
});
