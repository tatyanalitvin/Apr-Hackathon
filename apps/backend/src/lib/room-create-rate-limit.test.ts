// REQ-024 unit tests for the dual-tier rate limiter (burst 3/60s + sustained
// 20/24h). Round-trips through a real Redis client; the integration tests
// cover the route-level behaviour.

import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { createClient } from "redis";
import {
  checkRoomCreateRateLimit,
  closeRoomCreateRateLimit,
  BURST_LIMIT,
  SUSTAINED_LIMIT,
} from "./room-create-rate-limit";
import { env } from "../env";

const rawClient = createClient({ url: env.REDIS_URL });
await rawClient.connect();

async function flushBuckets(userId: string): Promise<void> {
  await rawClient.del(`rate:room-create-burst:${userId}`);
  await rawClient.del(`rate:room-create-sustained:${userId}`);
}

describe("REQ-024 checkRoomCreateRateLimit", () => {
  const userId = "test-user-rate";

  beforeEach(async () => {
    await flushBuckets(userId);
  });

  afterAll(async () => {
    await flushBuckets(userId);
    await rawClient.quit();
    await closeRoomCreateRateLimit();
  });

  test("REQ-024 allows first BURST_LIMIT attempts, denies on burst-limit+1", async () => {
    for (let i = 0; i < BURST_LIMIT; i++) {
      const out = await checkRoomCreateRateLimit(userId);
      expect(out.allowed).toBe(true);
      expect(out.retryAfterSec).toBe(0);
    }
    const denied = await checkRoomCreateRateLimit(userId);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60);
  });

  test("REQ-024 denies on sustained-limit+1 when sustained key is pre-seeded", async () => {
    // Seed sustained at the limit; leave burst empty.
    await rawClient.set(
      `rate:room-create-sustained:${userId}`,
      String(SUSTAINED_LIMIT),
    );
    await rawClient.expire(`rate:room-create-sustained:${userId}`, 24 * 60 * 60);
    const out = await checkRoomCreateRateLimit(userId);
    expect(out.allowed).toBe(false);
    // Sustained TTL (>60) proves it's the sustained bucket, not burst.
    expect(out.retryAfterSec).toBeGreaterThan(60);
  });

  test("REQ-024 when both buckets over → retryAfterSec reports the longer TTL", async () => {
    // Seed burst at limit (TTL ~60s) and sustained well past limit (TTL ~24h).
    await rawClient.set(`rate:room-create-burst:${userId}`, String(BURST_LIMIT));
    await rawClient.expire(`rate:room-create-burst:${userId}`, 60);
    await rawClient.set(
      `rate:room-create-sustained:${userId}`,
      String(SUSTAINED_LIMIT),
    );
    await rawClient.expire(`rate:room-create-sustained:${userId}`, 24 * 60 * 60);
    const out = await checkRoomCreateRateLimit(userId);
    expect(out.allowed).toBe(false);
    expect(out.retryAfterSec).toBeGreaterThan(60);
  });
});
