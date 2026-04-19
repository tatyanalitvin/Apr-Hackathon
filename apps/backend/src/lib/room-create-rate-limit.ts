// REQ-024 — per-user rate limit on POST /api/v1/rooms.
// Binding spec: docs/specs/s1-rooms.md §4 R7 (burst) + R8 (sustained) + §5.
//
// Dual-tier: burst 3/60s + sustained 20/24h. Both keys INCR on every attempt;
// rejected requests still burn the sustained bucket (intentional — the burst
// rate-limit is not a free retry window, so a 429-storm caps at the sustained
// ceiling rather than recovering every 60s).
//
// Pattern mirrors friend-rate-limit.ts: lazy connect-on-demand client,
// INCR + EXPIRE-on-first-write for self-expiring keys, closeRoomCreateRateLimit
// for Vitest teardown.

import { createClient, type RedisClientType } from "redis";
import { env } from "../env";

export const BURST_WINDOW_SECONDS = 60;
export const BURST_LIMIT = 3;
export const SUSTAINED_WINDOW_SECONDS = 24 * 60 * 60;
export const SUSTAINED_LIMIT = 20;

export interface RateLimitOutcome {
  allowed: boolean;
  retryAfterSec: number;
}

let client: RedisClientType | undefined;

async function getClient(): Promise<RedisClientType> {
  if (!client) {
    const c: RedisClientType = createClient({ url: env.REDIS_URL });
    c.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[room-create-rate-limit] redis error:", err);
    });
    await c.connect();
    client = c;
  }
  return client;
}

export async function checkRoomCreateRateLimit(
  userId: string,
): Promise<RateLimitOutcome> {
  const c = await getClient();
  const burstKey = `rate:room-create-burst:${userId}`;
  const sustainedKey = `rate:room-create-sustained:${userId}`;
  const [burstCount, sustainedCount] = await Promise.all([
    c.incr(burstKey),
    c.incr(sustainedKey),
  ]);
  if (burstCount === 1) await c.expire(burstKey, BURST_WINDOW_SECONDS);
  if (sustainedCount === 1) {
    await c.expire(sustainedKey, SUSTAINED_WINDOW_SECONDS);
  }
  const burstOver = burstCount > BURST_LIMIT;
  const sustainedOver = sustainedCount > SUSTAINED_LIMIT;
  if (!burstOver && !sustainedOver) {
    return { allowed: true, retryAfterSec: 0 };
  }
  const ttls = await Promise.all([
    burstOver ? c.ttl(burstKey) : Promise.resolve(0),
    sustainedOver ? c.ttl(sustainedKey) : Promise.resolve(0),
  ]);
  const retryAfterSec = Math.max(...ttls, 1);
  return { allowed: false, retryAfterSec };
}

export async function closeRoomCreateRateLimit(): Promise<void> {
  if (client) {
    await client.quit();
    client = undefined;
  }
}
