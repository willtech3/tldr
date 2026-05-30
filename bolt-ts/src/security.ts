/**
 * Request-side security controls for Slack-triggered work.
 *
 * These checks are intentionally small and dependency-free so they can run in
 * the Slack request path before the app enqueues expensive worker tasks.
 */

export const DEFAULT_MESSAGE_COUNT = 50;
export const MIN_MESSAGE_COUNT = 1;
export const MAX_MESSAGE_COUNT = 500;
/**
 * Cap on user-supplied custom style. Modern models comfortably handle longer
 * style guidance; we keep this aligned with the prompt builder's internal cap
 * so the Slack input modal `max_length` and the LLM-side truncation agree.
 */
export const MAX_CUSTOM_STYLE_LENGTH = 4000;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 5;
/** Sweep the rate-limit map once it grows past this many tracked users. */
const RATE_LIMIT_MAX_TRACKED_USERS = 10_000;
const MAX_MEMBERSHIP_PAGES = 20;
const MEMBERSHIP_PAGE_SIZE = 1000;
/** How long a (channel, user) membership result stays cached. */
const MEMBERSHIP_CACHE_TTL_MS = 60_000;
/** Hard cap on cached membership entries; the map is cleared when exceeded. */
const MEMBERSHIP_CACHE_MAX_ENTRIES = 10_000;

const DISALLOWED_STYLE_PATTERNS = [/system\s*:/i, /assistant\s*:/i, /user\s*:/i, /\{\{/];

interface RateLimitBucket {
  windowStartedAt: number;
  count: number;
}

/**
 * Per-(warm-container) request counters. Best-effort: limits are not shared
 * across concurrently running Lambda instances, and expired buckets are swept
 * lazily once the map grows past {@link RATE_LIMIT_MAX_TRACKED_USERS}.
 */
const rateLimitBuckets = new Map<string, RateLimitBucket>();

interface MembershipCacheEntry {
  result: boolean;
  at: number;
}

/**
 * Short-TTL cache for channel-membership checks. `conversations.members` can
 * paginate over thousands of members, so we avoid repeating it for the same
 * (channel, user) within {@link MEMBERSHIP_CACHE_TTL_MS}. Only definitive
 * results are cached — transient API errors and pagination-ceiling hits are
 * not. Per-container, like the rate limiter.
 */
const membershipCache = new Map<string, MembershipCacheEntry>();

function rememberMembership(key: string, result: boolean, now: number): boolean {
  if (membershipCache.size >= MEMBERSHIP_CACHE_MAX_ENTRIES) {
    membershipCache.clear();
  }
  membershipCache.set(key, { result, at: now });
  return result;
}

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

export function isValidSlackTimestamp(timestamp: string | null | undefined): timestamp is string {
  if (!timestamp) {
    return false;
  }

  return /^\d{10,}\.\d{6}$/.test(timestamp);
}

export function checkSummarizeRateLimit(userId: string, now = Date.now()): boolean {
  // Opportunistically sweep expired buckets so the per-container map can't grow
  // without bound across many distinct users on a long-lived warm Lambda.
  if (rateLimitBuckets.size > RATE_LIMIT_MAX_TRACKED_USERS) {
    for (const [trackedUser, tracked] of rateLimitBuckets) {
      if (now - tracked.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
        rateLimitBuckets.delete(trackedUser);
      }
    }
  }

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

export function resetMembershipCacheForTests(): void {
  membershipCache.clear();
}

export async function isUserMemberOfChannel(args: {
  client: ConversationsMembersClient;
  channelId: string;
  userId: string;
  logger: SecurityLogger;
  /** Injectable clock for tests. */
  now?: number;
}): Promise<boolean> {
  const { client, channelId, userId, logger } = args;
  if (!isValidSlackChannelId(channelId)) {
    return false;
  }

  const now = args.now ?? Date.now();
  const cacheKey = `${channelId}:${userId}`;
  const cached = membershipCache.get(cacheKey);
  if (cached && now - cached.at < MEMBERSHIP_CACHE_TTL_MS) {
    return cached.result;
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
        return rememberMembership(cacheKey, true, now);
      }

      const nextCursor = response.response_metadata?.next_cursor?.trim();
      if (!nextCursor) {
        return rememberMembership(cacheKey, false, now);
      }
      cursor = nextCursor;
    } catch (error) {
      // Don't cache transient failures — deny this time, retry next time.
      logger.warn('Failed to verify Slack channel membership before enqueueing work:', error);
      return false;
    }
  }

  // Pagination ceiling reached: treat as "couldn't verify" and don't cache.
  logger.warn('Slack channel membership check exceeded pagination limit');
  return false;
}
