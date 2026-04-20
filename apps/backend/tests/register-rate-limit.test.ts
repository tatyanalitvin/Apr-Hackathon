// REQ-009 — POST /api/auth/sign-up/email rate limit (5 / IP / hour).
//
// Contract (pinned in apps/backend/src/auth.ts):
//   rateLimit.customRules["/sign-up/email"] = { window: 3600, max: 5 }
// v4 REQ-009's /24 subnet rule is enforced one layer up by the Fastify
// preHandler (src/lib/register-rate-limit.ts) and pinned by
// src/lib/register-rate-limit.test.ts; this test file keeps fencing the
// per-/32 better-auth rule so the two layers stay independently covered.
//
// Runs in its own file so tests/setup.ts flushRedis() wipes the counter at
// the start. Six distinct signups (different emails/usernames) from the same
// IP: first 5 succeed; 6th is 429.
//
// In test mode the default `/sign-up/email` ceiling is relaxed to 10000 so
// unrelated test files (600+ sign-ups across the suite) don't bleed into
// each other's buckets — see auth.ts and docs/FOLLOWUPS.md "Backend sign-up
// rate-limit bleed". This file is the ONE place that needs the prod
// 5-per-hour contract, so it installs `__setTestSignUpMaxOverride(5)` before
// its own `buildApp()` to flip the rule back to the spec value, then clears
// the override on teardown so later test files see the 10000 ceiling again.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";
import { __setTestSignUpMaxOverride } from "../src/auth";

describe("REQ-009 register rate limit (5 / IP / hour)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    __setTestSignUpMaxOverride(5);
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    // Clear BEFORE app.close(); if close throws, the next file in the suite
    // would otherwise inherit our 5-req override and fail with 401s. See
    // docs/FOLLOWUPS.md "Backend sign-up rate-limit bleed".
    __setTestSignUpMaxOverride(undefined);
    await app.close();
  });

  test("REQ-009 6th signup from same IP within hour returns 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app.server)
        .post("/api/auth/sign-up/email")
        .send({
          email: `req009-${i}@example.com`,
          username: `req009_${i}`,
          password: "password1234",
          name: `Req009 ${i}`,
        });
      statuses.push(res.status);
    }
    for (const s of statuses) expect(s).toBe(200);

    const sixth = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "req009-6@example.com",
        username: "req009_6",
        password: "password1234",
        name: "Req009 6",
      });
    expect(sixth.status).toBe(429);
  });
});
