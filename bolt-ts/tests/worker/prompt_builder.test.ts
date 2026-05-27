import { applySafetyNetSections } from '../../src/worker/prompt_builder';

describe('applySafetyNetSections', () => {
  it('appends Links shared, Image highlights, and Receipts when missing', () => {
    const result = applySafetyNetSections('*Summary*\nThings happened.', {
      linksShared: [],
      receiptPermalinks: [],
      hasAnyImages: false,
    });
    expect(result).toContain('*Links shared*');
    expect(result).toContain('*Image highlights*');
    expect(result).toContain('*Receipts*');
    expect(result).toContain('- None');
  });

  it('does not duplicate sections already present in the summary', () => {
    const summary = '*Summary*\nfoo\n*Links shared*\n- existing\n*Image highlights*\n- existing\n*Receipts*\n- existing';
    const result = applySafetyNetSections(summary, {
      linksShared: ['https://shouldnotappear.example'],
      receiptPermalinks: ['https://shouldnotappear.example'],
      hasAnyImages: true,
    });
    expect(result).toBe(summary);
  });

  it('inserts known links and receipts when sections are missing', () => {
    const result = applySafetyNetSections('*Summary*\nthings.', {
      linksShared: ['https://example.com'],
      receiptPermalinks: ['https://slack.example/archives/C/p1'],
      hasAnyImages: true,
    });
    expect(result).toContain('- https://example.com');
    expect(result).toContain('- https://slack.example/archives/C/p1');
    expect(result).toContain('- (No image highlights provided.)');
  });
});
