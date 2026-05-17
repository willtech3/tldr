/**
 * Request-side security controls for Slack-triggered work.
 *
 * These checks are intentionally small and dependency-free so they can run in
 * the Slack request path before the app enqueues expensive worker tasks.
 */

export const DEFAULT_MESSAGE_COUNT = 50;
export const MIN_MESSAGE_COUNT = 1;
export const MAX_MESSAGE_COUNT = 500;
export const MAX_CUSTOM_STYLE_LENGTH = 800;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const MAX_MEMBERSHIP_PAGES = 20;
const MEMBERSHIP_PAGE_SIZE = 1000;

const DISALLOWED_STYLE_PATTERNS = [/system\s*:/i, /assistant\s*:/i, /user\s*:/i, /\{\{/];

interface RateLimitBucket {
  windowStartedAt: number;
  count: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();

export interface SecurityLogger {
  warn(message: string, ...args: unknown[]): void;
}

export interface ConversationsMembersClient {
  conversations: {
    members(args: {
      channel: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      members?: string[];
      response_metadata?: {
        next_cursor?: string;
      };
    }>;
  };
}

export function normalizeMessageCount(
  count: number | null | undefined,
  fallback = DEFAULT_MESSAGE_COUNT
): number {
  const raw = count ?? fallback;
  if (!Number.isFinite(raw)) {
    return fallback;
  }

  const whole = Math.trunc(raw);
  if (whole < MIN_MESSAGE_COUNT) {
    return MIN_MESSAGE_COUNT;
  }
  if (whole > MAX_MESSAGE_COUNT) {
    return MAX_MESSAGE_COUNT;
  }
  return whole;
}

export function validateAndSanitizeStyle(raw: string | null | undefined):
  | { ok: true; value: string | null }
  | { ok: false; reason: string } {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null };
  }

  const trimmed = Array.from(raw)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim();

  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }

  if (trimmed.length > MAX_CUSTOM_STYLE_LENGTH) {
    return {
      ok: false,
      reason: `Style instructions must be ${MAX_CUSTOM_STYLE_LENGTH} characters or fewer.`,
    };
  }

  if (DISALLOWED_STYLE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return {
      ok: false,
      reason: 'Style instructions cannot include role labels or template markers.',
    };
  }

  return { ok: true, value: trimmed };
}

export function isValidSlackChannelId(channelId: string | null | undefined): channelId is string {
  if (!channelId) {
    return false;
  }

  return /^[A-Z][A-Z0-9]{8,}$/.test(channelId);
}

export function checkSummarizeRateLimit(userId: string, now = Date.now()): boolean {
  const bucket = rateLimitBuckets.get(userId);
  if (!bucket || now - bucket.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.set(userId, { windowStartedAt: now, count: 1 });
    return true;
  }

  if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  bucket.count += 1;
  return true;
}

export function resetRateLimitForTests(): void {
  rateLimitBuckets.clear();
}

export function sanitizeGeneratedSlackText(text: string): string {
  return text
    .replace(/<!(channel|here|everyone)>/g, '`$&`')
    .replace(/<!subteam\^[^>]+>/g, '`$&`')
    .replace(/<@[UW][A-Z0-9]+>/g, '`$&`');
}

export async function isUserMemberOfChannel(args: {
  client: ConversationsMembersClient;
  channelId: string;
  userId: string;
  logger: SecurityLogger;
}): Promise<boolean> {
  const { client, channelId, userId, logger } = args;
  if (!isValidSlackChannelId(channelId)) {
    return false;
  }

  let cursor: string | undefined;
  for (let page = 0; page < MAX_MEMBERSHIP_PAGES; page += 1) {
    try {
      const response = await client.conversations.members({
        channel: channelId,
        cursor,
        limit: MEMBERSHIP_PAGE_SIZE,
      });

      if (response.members?.includes(userId)) {
        return true;
      }

      const nextCursor = response.response_metadata?.next_cursor?.trim();
      if (!nextCursor) {
        return false;
      }
      cursor = nextCursor;
    } catch (error) {
      logger.warn('Failed to verify Slack channel membership before enqueueing work:', error);
      return false;
    }
  }

  logger.warn('Slack channel membership check exceeded pagination limit');
  return false;
}
