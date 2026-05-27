import { buildImageBlock, canonicalizeMime, isAllowedImageMime } from '../../src/ai/images';

describe('canonicalizeMime', () => {
  it('lowercases and trims parameters', () => {
    expect(canonicalizeMime('Image/PNG; charset=binary')).toBe('image/png');
  });

  it('maps image/jpg onto image/jpeg', () => {
    expect(canonicalizeMime('image/jpg')).toBe('image/jpeg');
  });

  it('returns an empty string for unparseable input', () => {
    expect(canonicalizeMime('')).toBe('');
  });
});

describe('isAllowedImageMime', () => {
  it('accepts the canonical allowed set', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
      expect(isAllowedImageMime(mime)).toBe(true);
    }
  });

  it('accepts jpg synonym after canonicalisation', () => {
    expect(isAllowedImageMime('image/jpg')).toBe(true);
  });

  it('rejects unsupported formats', () => {
    expect(isAllowedImageMime('image/heic')).toBe(false);
    expect(isAllowedImageMime('image/tiff')).toBe(false);
    expect(isAllowedImageMime('application/pdf')).toBe(false);
  });
});

describe('buildImageBlock', () => {
  it('produces an Anthropic image block with base64 data', () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const block = buildImageBlock('image/jpg', bytes);
    expect(block).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: '3q2+7w==',
      },
    });
  });

  it('throws for unsupported MIME types', () => {
    expect(() => buildImageBlock('image/heic', new Uint8Array([0]))).toThrow(
      /Unsupported image MIME type/
    );
  });
});
