// REQ-024 integration tests for POST /api/v1/rooms rate limit.
// Dual-tier: burst 3/60s, sustained 20/24h. Binding: docs/specs/s1-rooms.md §4 R7/R8.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { createClient } from "redis";
import { eq } from "drizzle-orm";
import { user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { env } from "../src/env";
import { flushRedis, getTestDb } from "./db-helpers";

interface SignedUpAgent {
  agent: request.Agent;
  userId: string;
}

async function userIdByEmail(email: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return row.id;
}

async function registerAgent(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<SignedUpAgent> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: "password1234", name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

describe("REQ-024 POST /api/v1/rooms rate-limit", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await flushRedis();
  });

  test("REQ-024 burst: first 3 creates succeed, 4th in 60s window → 429", async () => {
    const alice = await registerAgent(app, "r024b@example.com", "r024_b");
    for (let i = 0; i < 3; i++) {
      const res = await alice.agent
        .post("/api/v1/rooms")
        .send({ name: `R024 Burst ${i}` });
      expect(res.status).toBe(201);
    }
    const denied = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "R024 Burst 4" });
    expect(denied.status).toBe(429);
    expect(denied.body).toMatchObject({ error: "rate_limited" });
    expect(typeof denied.body.retryAfterSec).toBe("number");
    expect(denied.body.retryAfterSec).toBeGreaterThan(0);
    expect(denied.body.retryAfterSec).toBeLessThanOrEqual(60);
  });

  test("REQ-024 sustained: pre-seed sustained bucket → next create → 429 with long TTL", async () => {
    const alice = await registerAgent(app, "r024s@example.com", "r024_s");
    // Pre-fill sustained bucket via a direct Redis connection.
    const c = createClient({ url: env.REDIS_URL });
    await c.connect();
    const sustainedKey = `rate:room-create-sustained:${alice.userId}`;
    await c.set(sustainedKey, "20"); // exactly at SUSTAINED_LIMIT
    await c.expire(sustainedKey, 24 * 60 * 60);
    await c.quit();

    const denied = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "R024 Sustained 1" });
    expect(denied.status).toBe(429);
    expect(denied.body).toMatchObject({ error: "rate_limited" });
    // retryAfterSec > 60 proves sustained bucket fired, not burst.
    expect(denied.body.retryAfterSec).toBeGreaterThan(60);
  });

  test("REQ-024 denied requests still burn the sustained bucket (non-negotiable)", async () => {
    const alice = await registerAgent(app, "r024bn@example.com", "r024_bn");

    // Trip burst (3 success + 1 denied).
    for (let i = 0; i < 3; i++) {
      const ok = await alice.agent
        .post("/api/v1/rooms")
        .send({ name: `R024 Bleed ${i}` });
      expect(ok.status).toBe(201);
    }
    const deniedByBurst = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "R024 Bleed 4" });
    expect(deniedByBurst.status).toBe(429);

    // Inspect the sustained bucket — denied attempt MUST have INCRed it past 3.
    const c = createClient({ url: env.REDIS_URL });
    await c.connect();
    const sustainedCount = await c.get(
      `rate:room-create-sustained:${alice.userId}`,
    );
    await c.quit();
    expect(Number(sustainedCount)).toBe(4);
  });
});
