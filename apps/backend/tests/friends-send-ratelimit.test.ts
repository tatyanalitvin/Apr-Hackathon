// R5 / REQ-054 — rate limit on POST /api/v1/friends/requests.
// Binding spec: docs/specs/s2-friendship.md §4 R5 + §5 ordering.
//
// 20 outgoing friend-request attempts per caller per rolling 24h window;
// the 21st returns 429 { error: "rate_limited", retryAfterSec }. Bucket
// counts every attempt that passes auth + zod, INCLUDING the sentinel-
// success path (R4) — otherwise a blocked caller could enumerate
// usernames by rate-limit-burn. Ordering asserted: rate-limit fires
// BEFORE block check.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { user, userBlock } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

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

describe("REQ-054 POST /api/v1/friends/requests rate-limit", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-054 20 attempts succeed, 21st returns 429 rate_limited", async () => {
    const alice = await registerAgent(app, "r054-alice@example.com", "r054_alice");
    const bob = await registerAgent(app, "r054-bob@example.com", "r054_bob");
    void alice.userId;
    void bob.userId;

    for (let i = 0; i < 20; i++) {
      const res = await alice.agent
        .post("/api/v1/friends/requests")
        .send({ toUsername: "r054_bob", message: `attempt ${i}` });
      // First attempt inserts (201); 2..20 update the duplicate (200).
      expect([200, 201]).toContain(res.status);
    }

    const blocked = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "r054_bob", message: "attempt 21" });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: "rate_limited" });
    expect(typeof blocked.body.retryAfterSec).toBe("number");
    expect(blocked.body.retryAfterSec).toBeGreaterThan(0);
  });

  test("REQ-054 rate-limit runs before block check — blocked caller hits 429 on #21", async () => {
    // bob blocks alice. Every attempt is a sentinel-success (R4) until the
    // bucket fills; the 21st attempt must be 429, NOT another sentinel 201.
    const alice = await registerAgent(app, "r054o-alice@example.com", "r054o_alice");
    const bob = await registerAgent(app, "r054o-bob@example.com", "r054o_bob");
    await getTestDb().insert(userBlock).values({
      id: randomUUID(),
      byId: bob.userId,
      targetId: alice.userId,
    });

    for (let i = 0; i < 20; i++) {
      const res = await alice.agent
        .post("/api/v1/friends/requests")
        .send({ toUsername: "r054o_bob" });
      expect(res.status).toBe(201);
    }

    const blocked = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "r054o_bob" });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: "rate_limited" });
  });
});
