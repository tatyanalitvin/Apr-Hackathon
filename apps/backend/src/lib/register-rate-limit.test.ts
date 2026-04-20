// REQ-009 — /24 subnet bucket helper + Redis-counted limit.
// Exercises `subnetBucket` (pure) and `checkRegisterRateLimit` (real Redis
// via tests/setup.ts flushRedis()). The Fastify preHandler wiring is a
// 3-line passthrough on top of this and is covered implicitly by the
// existing per-IP register-rate-limit.test.ts (same-IP path still 429s at
// 6).

import { afterAll, describe, expect, test } from "vitest";
import {
  checkRegisterRateLimit,
  closeRegisterRateLimit,
  REGISTER_SUBNET_LIMIT,
  subnetBucket,
} from "./register-rate-limit";

describe("REQ-009 subnetBucket (pure)", () => {
  test("IPv4 → /24 bucket drops the last octet", () => {
    expect(subnetBucket("10.0.1.42")).toBe("10.0.1.0/24");
    expect(subnetBucket("10.0.1.255")).toBe("10.0.1.0/24");
    expect(subnetBucket("192.168.0.1")).toBe("192.168.0.0/24");
  });

  test("two distinct /32 IPv4s in the same /24 collapse to one bucket", () => {
    expect(subnetBucket("203.0.113.7")).toBe(subnetBucket("203.0.113.254"));
  });

  test("adjacent /24s yield distinct buckets", () => {
    expect(subnetBucket("203.0.113.7")).not.toBe(subnetBucket("203.0.114.7"));
  });

  test("IPv4-mapped IPv6 (::ffff:...) unwraps to IPv4 then /24", () => {
    expect(subnetBucket("::ffff:10.0.1.42")).toBe("10.0.1.0/24");
  });

  test("IPv6 → /64 bucket keeps the first 4 groups, zero-padded", () => {
    expect(subnetBucket("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(subnetBucket("2001:db8:1:2:3:4:5:6")).toBe(
      "2001:0db8:0001:0002::/64",
    );
  });

  test("unparseable input falls through to the raw string (fail-safe)", () => {
    expect(subnetBucket("not-an-ip")).toBe("not-an-ip");
  });
});

describe("REQ-009 checkRegisterRateLimit (Redis-backed /24 bucketing)", () => {
  // flushRedis() in tests/setup.ts wipes counters before every test so
  // each case starts from a clean bucket.

  afterAll(async () => {
    await closeRegisterRateLimit();
  });

  test("6th sign-up across distinct /32 IPs in one /24 trips the limit", async () => {
    // This is the exact attack shape REQ-009 exists to cover: attacker
    // rotates IPs within a single /24 to side-step a /32 bucket.
    const rotating = [
      "203.0.113.1",
      "203.0.113.2",
      "203.0.113.3",
      "203.0.113.4",
      "203.0.113.5",
    ];
    for (const ip of rotating) {
      const out = await checkRegisterRateLimit(ip);
      expect(out.allowed).toBe(true);
    }
    const denied = await checkRegisterRateLimit("203.0.113.99");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
  });

  test("exhausted /24 does not leak into an adjacent /24", async () => {
    for (let i = 0; i < REGISTER_SUBNET_LIMIT; i++) {
      await checkRegisterRateLimit("203.0.113.7");
    }
    const sameBlockDenied = await checkRegisterRateLimit("203.0.113.8");
    expect(sameBlockDenied.allowed).toBe(false);
    const adjacentBlockAllowed = await checkRegisterRateLimit("203.0.114.7");
    expect(adjacentBlockAllowed.allowed).toBe(true);
  });
});
