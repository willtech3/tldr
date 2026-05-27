/**
 * Image MIME helpers shared between the prompt builder and Slack image fetcher.
 *
 * Anthropic accepts base64-encoded image content blocks with explicit
 * `media_type`. Supported types per Anthropic: jpeg, png, gif, webp.
 */

import type { ImageBlock } from './prompt';

export const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export type AnthropicImageMime = ImageBlock['source']['media_type'];

/**
 * Strip parameters and lowercase the MIME type, mapping the common
 * `image/jpg` synonym onto `image/jpeg`.
 */
export function canonicalizeMime(mime: string): string {
  const main = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return main === 'image/jpg' ? 'image/jpeg' : main;
}

export function isAllowedImageMime(mime: string): boolean {
  return ALLOWED_IMAGE_MIME.has(canonicalizeMime(mime));
}

/**
 * Build an Anthropic image content block from raw bytes + a MIME hint. Throws
 * if the MIME is unsupported — callers should pre-filter with
 * {@link isAllowedImageMime}.
 */
export function buildImageBlock(mime: string, bytes: Uint8Array): ImageBlock {
  const canon = canonicalizeMime(mime);
  if (!ALLOWED_IMAGE_MIME.has(canon)) {
    throw new Error(`Unsupported image MIME type: ${mime}`);
  }
  const data = Buffer.from(bytes).toString('base64');
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: canon as AnthropicImageMime,
      data,
    },
  };
}
