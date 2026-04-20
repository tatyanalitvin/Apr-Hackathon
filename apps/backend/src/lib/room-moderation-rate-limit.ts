// Spec: docs/specs/s3-gc-and-moderation-rl.md §4 R1, R9, §5.
//
// Per-(user, room) dual-tier limiter on room moderation actions
// (promote/demote/kick/ban/unban). Burst (10/60s) catches impatient clickers;
// sustained (60/3600s) catches compromised admins scripting the endpoint.
//
// INCR-order discipline (see R1.note): burst first; if burst blocked, READ
// sustained with GET instead of INCR; if sustained overflows, DECR burst
// best-effort. Naive "INCR both every call" would turn a 1-minute block into
// a 1-hour jail for a retrying client.
//
// Separate Redis client from @fastify/rate-limit's ioredis and from
// better-auth's secondary-storage (R9) — lifecycles + client libraries
// diverge. Mirrors friend-rate-limit.ts.
//
// Redis-outage policy: any error fails OPEN with a WARN log. A Redis outage
// must not brick moderation (you'd lock out every admin in the product).

import { createClient, type RedisClientType } from "redis";
import { env } from "../env";

export const MOD_BURST_WINDOW_SEC = 60;
export const MOD_BURST_LIMIT = 10;
export const MOD_SUSTAINED_WINDOW_SEC = 60 * 60;
export const MOD_SUSTAINED_LIMIT = 60;

let client: RedisClientType | undefined;

async function getClient(): Promise<RedisClientType> {
  if (!client) {
    const c: RedisClientType = createClient({ url: env.REDIS_URL });
    c.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[room-moderation-rate-limit] redis error:", err);
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

function burstKey(userId: string, roomId: string): string {
  return `rate:mod:burst:${userId}:${roomId}`;
}

function sustainedKey(userId: string, roomId: string): string {
  return `rate:mod:sustained:${userId}:${roomId}`;
}

export async function checkModerationRateLimit(
  userId: string,
  roomId: string,
): Promise<RateLimitOutcome> {
  try {
    const c = await getClient();
    const bk = burstKey(userId, roomId);
    const sk = sustainedKey(userId, roomId);

    const burstCount = await c.incr(bk);
    if (burstCount === 1) await c.expire(bk, MOD_BURST_WINDOW_SEC);

    if (burstCount > MOD_BURST_LIMIT) {
      // Burst blocked — DO NOT INCR sustained; just peek at it for retry calc.
      const burstTtl = await c.ttl(bk);
      const sustainedRaw = await c.get(sk);
      const sustainedCount = sustainedRaw ? Number.parseInt(sustainedRaw, 10) : 0;
      let retry = burstTtl > 0 ? burstTtl : MOD_BURST_WINDOW_SEC;
      if (sustainedCount > MOD_SUSTAINED_LIMIT) {
        const sustainedTtl = await c.ttl(sk);
        const s = sustainedTtl > 0 ? sustainedTtl : MOD_SUSTAINED_WINDOW_SEC;
        if (s > retry) retry = s;
      }
      return { allowed: false, retryAfterSec: retry };
    }

    const sustainedCount = await c.incr(sk);
    if (sustainedCount === 1) await c.expire(sk, MOD_SUSTAINED_WINDOW_SEC);

    if (sustainedCount > MOD_SUSTAINED_LIMIT) {
      // Sustained blocked — best-effort DECR burst so the rejected call
      // doesn't also burn the burst allowance.
      try {
        await c.decr(bk);
      } catch {
        // swallow — worst case the caller loses one burst slot.
      }
      const sustainedTtl = await c.ttl(sk);
      const burstTtl = await c.ttl(bk);
      const sRetry = sustainedTtl > 0 ? sustainedTtl : MOD_SUSTAINED_WINDOW_SEC;
      const bRetry = burstTtl > 0 ? burstTtl : MOD_BURST_WINDOW_SEC;
      return {
        allowed: false,
        retryAfterSec: sRetry > bRetry ? sRetry : bRetry,
      };
    }

    return { allowed: true, retryAfterSec: 0 };
  } catch (err) {
    // Fail-open: a Redis outage must not brick moderation. Mirrors
    // @fastify/rate-limit's skipOnError:true at app.ts.
    // eslint-disable-next-line no-console
    console.warn("[room-moderation-rate-limit] fail-open:", err);
    return { allowed: true, retryAfterSec: 0 };
  }
}

export async function closeModerationRateLimit(): Promise<void> {
  if (client) {
    await client.quit();
    client = undefined;
  }
}
