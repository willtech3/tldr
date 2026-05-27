/**
 * UTF-8 safe streaming chunker for Slack's `chat.appendStream` API.
 *
 * Split priority: paragraph (`\n\n`), line (`\n`), whitespace, then a hard
 * codepoint cap.
 */

/**
 * Drain up to `maxChars` codepoints from `buffer`, preferring natural breakpoints.
 * Returns the drained chunk, or `null` if the buffer is empty.
 *
 * Mutates `buffer` by removing the chunk from the front and returns the new buffer
 * value via the second-element of the returned tuple.
 */
export function takeStreamChunk(
  buffer: string,
  maxChars: number
): { chunk: string; rest: string } | null {
  if (buffer.length === 0) {
    return null;
  }

  const codepoints = [...buffer];
  if (codepoints.length <= maxChars) {
    return { chunk: buffer, rest: '' };
  }

  const prefix = codepoints.slice(0, maxChars).join('');

  // Priority 1 & 2: paragraph / line breaks.
  let split = findLastIndex(prefix, '\n\n');
  if (split !== -1 && split > 0) {
    split += 2;
  } else {
    split = findLastIndex(prefix, '\n');
    if (split !== -1 && split > 0) {
      split += 1;
    } else {
      split = -1;
    }
  }

  // Priority 3: any whitespace.
  if (split === -1) {
    let lastWs = -1;
    let idx = 0;
    for (const ch of prefix) {
      idx += ch.length;
      if (/\s/.test(ch)) {
        lastWs = idx;
      }
    }
    if (lastWs > 0) {
      split = lastWs;
    }
  }

  // Priority 4: hard split at maxChars codepoints.
  if (split === -1) {
    split = prefix.length;
  }

  const chunk = buffer.substring(0, split);
  const rest = buffer.substring(split);
  return { chunk, rest };
}

function findLastIndex(haystack: string, needle: string): number {
  return haystack.lastIndexOf(needle);
}
