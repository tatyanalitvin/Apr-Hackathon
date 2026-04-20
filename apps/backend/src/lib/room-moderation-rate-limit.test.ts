// Spec: docs/specs/s3-gc-and-moderation-rl.md §4 R1, §5.
//
// Unit-level tests for the dual-tier (burst + sustained) moderation limiter.
// Drives the helper directly — no HTTP. Burst cap 10/60s, sustained 60/3600s.
// Because the sustained cap is 6× burst, a single caller hitting only burst
// rejections never actually reaches the sustained cap within one burst
// window; the INCR-order discipline (burst first; GET sustained if burst
// blocked; DECR burst if sustained overflows) is what prevents rejections
// from converting a 1-min block into a 1-hour jail.

import { beforeEach, describe, expect, test } from "vitest";
import {
  MOD_BURST_LIMIT,
  MOD_SUSTAINED_LIMIT,
  checkModerationRateLimit,
} from "./room-moderation-rate-limit";
import { flushRedis } from "../../tests/db-helpers";

describe("room-moderation-rate-limit — burst tier", () => {
  beforeEach(async () => {
    await flushRedis();
  });

  test("allows up to MOD_BURST_LIMIT calls, rejects on overflow", async () => {
    for (let i = 0; i < MOD_BURST_LIMIT; i++) {
      const r = await checkModerationRateLimit("u1", "r1");
      expect(r.allowed).toBe(true);
      expect(r.retryAfterSec).toBe(0);
    }
    const overflow = await checkModerationRateLimit("u1", "r1");
    expect(overflow.allowed).toBe(false);
    expect(overflow.retryAfterSec).toBeGreaterThan(0);
  });

  test("separate (userId, roomId) buckets don't cross-pollinate", async () => {
    for (let i = 0; i < MOD_BURST_LIMIT; i++) {
      await checkModerationRateLimit("u1", "r1");
    }
    // Same user, different room: fresh bucket.
    const otherRoom = await checkModerationRateLimit("u1", "r2");
    expect(otherRoom.allowed).toBe(true);
    // Different user, same room: fresh bucket.
    const otherUser = await checkModerationRateLimit("u2", "r1");
    expect(otherUser.allowed).toBe(true);
  });

  test("rejected call does NOT burn sustained tier (INCR-order discipline)", async () => {
    // Blow the burst cap.
    for (let i = 0; i < MOD_BURST_LIMIT; i++) {
      await checkModerationRateLimit("u1", "r1");
    }
    // Spam MANY more rejected calls. If the helper naively INCR'd sustained
    // for every call including rejections, MOD_SUSTAINED_LIMIT would tip and
    // the reported retryAfterSec would be the sustained TTL (~3600s).
    for (let i = 0; i < MOD_SUSTAINED_LIMIT + 20; i++) {
      const r = await checkModerationRateLimit("u1", "r1");
      expect(r.allowed).toBe(false);
      // Still in burst-block territory (< 60s), not sustained-block (3600s).
      expect(r.retryAfterSec).toBeLessThanOrEqual(60);
    }
  });
});

describe("room-moderation-rate-limit — retry-after shape", () => {
  beforeEach(async () => {
    await flushRedis();
  });

  test("allowed response has retryAfterSec=0", async () => {
    const r = await checkModerationRateLimit("u1", "r1");
    expect(r).toEqual({ allowed: true, retryAfterSec: 0 });
  });

  test("rejected response has positive retryAfterSec", async () => {
    for (let i = 0; i < MOD_BURST_LIMIT; i++) {
      await checkModerationRateLimit("u1", "r1");
    }
    const r = await checkModerationRateLimit("u1", "r1");
    expect(r.allowed).toBe(false);
    expect(typeof r.retryAfterSec).toBe("number");
    expect(r.retryAfterSec).toBeGreaterThan(0);
  });
});
