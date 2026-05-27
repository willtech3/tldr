import { takeStreamChunk } from '../../src/worker/chunks';

function takeAll(buffer: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = buffer;
  while (true) {
    const result = takeStreamChunk(current, maxChars);
    if (!result) {
      break;
    }
    chunks.push(result.chunk);
    current = result.rest;
  }
  return chunks;
}

describe('takeStreamChunk', () => {
  it('returns null for an empty buffer', () => {
    expect(takeStreamChunk('', 100)).toBeNull();
  });

  it('returns the entire buffer when smaller than max', () => {
    const result = takeStreamChunk('short', 100);
    expect(result).toEqual({ chunk: 'short', rest: '' });
  });

  it('prefers paragraph boundaries', () => {
    expect(takeAll('para1\n\npara2\n\npara3', 8)).toEqual(['para1\n\n', 'para2\n\n', 'para3']);
  });

  it('prefers line over whitespace boundary', () => {
    const result = takeStreamChunk('line1\nword1 word2 word3', 10);
    expect(result?.chunk).toBe('line1\n');
    expect(result?.rest).toBe('word1 word2 word3');
  });

  it('falls back to whitespace boundary when no newline present', () => {
    const result = takeStreamChunk('word1 word2 word3 word4', 12);
    expect(result?.chunk).toBe('word1 word2 ');
    expect(result?.rest).toBe('word3 word4');
  });

  it('falls back to a hard split when no natural breakpoint exists', () => {
    expect(takeAll('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('handles emoji boundaries safely', () => {
    const result = takeStreamChunk('Hello😀World', 6);
    expect(result?.chunk).toBe('Hello😀');
    expect(result?.rest).toBe('World');
  });

  it('handles CJK boundaries safely', () => {
    const result = takeStreamChunk('你好世界早上好', 4);
    expect(result?.chunk).toBe('你好世界');
    expect(result?.rest).toBe('早上好');
  });

  it('preserves all content across chunks (no data loss)', () => {
    const original = 'Hello 你好 🎉 World 世界!';
    expect(takeAll(original, 5).join('')).toBe(original);
  });

  it('never exceeds maxChars per chunk', () => {
    const text = 'This is a longer string with multiple words and spaces';
    for (const chunk of takeAll(text, 10)) {
      expect([...chunk].length).toBeLessThanOrEqual(10);
    }
  });
});
