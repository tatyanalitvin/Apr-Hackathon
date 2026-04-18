// R5 / REQ-054 — per-user rate limit on POST /api/v1/friends/requests.
// Binding spec: docs/specs/s2-friendship.md §4 R5 + §5 ordering.
//
// 20 attempts per caller per rolling 24h window. The limiter runs BEFORE
// the block check (§5 step 3 vs step 6) so a blocked caller can't
// enumerate usernames for free. We use INCR + EXPIRE-on-first-write so
// the key self-expires; no separate sweep needed.
//
// Separate Redis client from better-auth's secondary-storage to keep the
// lifecycles decoupled (and because secondary-storage.ts wraps its
// client in a closure and exposes only get/set/delete). Test harness's
// beforeEach flushRedis() resets counters between tests.

import { createClient, type RedisClientType } from "redis";
import { env } from "../env";

const WINDOW_SECONDS = 24 * 60 * 60;
export const FRIEND_REQUEST_LIMIT = 20;

let client: RedisClientType | undefined;

async function getClient(): Promise<RedisClientType> {
  if (!client) {
    const c: RedisClientType = createClient({ url: env.REDIS_URL });
    c.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[friend-rate-limit] redis error:", err);
    });
    await c.connect();
    client = c;
  }
  return client;
}

export interface RateLimitOutcome {
  allowed: boolean;
  retryAfterSec: number;
}

// Atomic-ish check: INCR returns the new count; if it's 1 we just
// created the key and set its TTL. For counts ≤ LIMIT we're good.
// Above LIMIT we read PTTL to compute retryAfterSec.
export async function checkFriendRequestRateLimit(
  userId: string,
): Promise<RateLimitOutcome> {
  const c = await getClient();
  const key = `rate:friend-req:${userId}`;
  const count = await c.incr(key);
  if (count === 1) {
    await c.expire(key, WINDOW_SECONDS);
  }
  if (count <= FRIEND_REQUEST_LIMIT) {
    return { allowed: true, retryAfterSec: 0 };
  }
  const ttl = await c.ttl(key);
  return { allowed: false, retryAfterSec: ttl > 0 ? ttl : WINDOW_SECONDS };
}

export async function closeFriendRateLimit(): Promise<void> {
  if (client) {
    await client.quit();
    client = undefined;
  }
}
