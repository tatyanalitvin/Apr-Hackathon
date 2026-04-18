// REQ-009 — POST /api/auth/sign-up/email rate limit (5 / IP / hour).
//
// Contract (pinned in apps/backend/src/auth.ts):
//   rateLimit.customRules["/sign-up/email"] = { window: 3600, max: 5 }
// v4 REQ-009 also specifies a /24 subnet rule (20/hour across an IP block);
// that requires a custom keyGenerator + CIDR math and is deferred to S3
// (FOLLOWUPS.md #6). This test fences only the per-IP rule.
//
// Runs in its own file so tests/setup.ts flushRedis() wipes the counter at
// the start. Six distinct signups (different emails/usernames) from the same
// IP: first 5 succeed; 6th is 429.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";

describe("REQ-009 register rate limit (5 / IP / hour)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
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
