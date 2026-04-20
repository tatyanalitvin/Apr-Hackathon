import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// Sign-in IP rate-limit gate (deviation from v4 REQ-012 per-email lockout,
// see ADR-0006).
//
// Contract (pinned in apps/backend/src/auth.ts):
//   rateLimit.customRules["/sign-in/email"] = { window: 60, max: 5 }
// The first 5 wrong-password attempts from a single IP return the normal
// INVALID_EMAIL_OR_PASSWORD 4xx; the 6th trips the rate-limiter and returns
// 429. v4 REQ-012 actually mandates per-email lockout (10 fails/15min, code
// `auth_locked`). Per-IP is weaker — a botnet bypasses it. Implementing
// REQ-012 properly requires a new counter store keyed by email + `auth_locked`
// error wiring through better-auth's login handler; deferred to S3
// (FOLLOWUPS.md #7).
//
// Runs in its own file so that flushRedis() in the harness beforeEach (see
// tests/setup.ts + secondary-storage.ts) wipes the counter before this test
// starts. That's why we can state "5 × 401, 6th × 429" deterministically
// despite running in the shared singleFork process (ADR-0005).
//
// Explicitly NOT covered here (per the task #4 scope lock):
//   - window-expiry / fake-timer behaviour (a 60s real sleep is wasteful;
//     better-auth's TTL semantics are the library's concern, not v3's).
//   - /sign-up/email or /forget-password budgets (neither is in v3).

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";

const victim = {
  email: "rate-victim@example.com",
  username: "rate_victim",
  password: TEST_PASSWORD_OK,
  name: "Rate Victim",
};

describe("sign-in IP rate limit (deviation from v4 REQ-012 per-email lockout, see ADR-0006)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("5 wrong-password attempts return 4xx; 6th returns 429", async () => {
    await request(app.server)
      .post("/api/auth/sign-up/email")
      .send(victim)
      .expect(200);

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app.server)
        .post("/api/auth/sign-in/email")
        .send({ email: victim.email, password: "wrong-password" });
      statuses.push(res.status);
    }

    // Every one of the first five must be an auth-failure 4xx in the
    // 400–428 range (429 is the rate-limit signal, must not appear yet).
    for (const s of statuses) {
      expect(s).toBeGreaterThanOrEqual(400);
      expect(s).toBeLessThan(500);
      expect(s).not.toBe(429);
    }

    const sixth = await request(app.server)
      .post("/api/auth/sign-in/email")
      .send({ email: victim.email, password: "wrong-password" });
    expect(sixth.status).toBe(429);
  });
});
