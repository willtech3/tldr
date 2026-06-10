/**
 * Tests for share-related helpers in the action handlers.
 */

import { stripSummaryHeader } from '../../src/handlers/actions';

describe('stripSummaryHeader', () => {
  it('strips the markdown-source header and style line', () => {
    const text = '_Style: be funny_\n\n**Summary of #general**\n\nThe team shipped.';
    expect(stripSummaryHeader(text)).toBe('The team shipped.');
  });

  it('strips an mrkdwn-rendered copy of the header (single asterisks)', () => {
    const text = '*Summary of #general*\n\nThe team shipped.';
    expect(stripSummaryHeader(text)).toBe('The team shipped.');
  });

  it('leaves bodies without a header untouched', () => {
    expect(stripSummaryHeader('Just a body.')).toBe('Just a body.');
  });
});
