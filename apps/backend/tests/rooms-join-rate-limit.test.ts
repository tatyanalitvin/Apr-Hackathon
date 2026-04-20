import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-026 — per-user rate limit on POST /api/v1/rooms/:id/join.
// Binding spec: docs/specs/s2-rooms.md §5 (rate-limit placement).
//
// 60 joins per caller per rolling 1-hour window; the 61st returns 429
// { error: "rate_limited", retryAfterSec }. Ordering asserted: rate-limit
// fires BEFORE the room-exists lookup (§5), so probing with invalid ids
// doesn't circumvent the cap.
//
// Every self-join counts against the bucket — including idempotent repeats
// and the 404-branch (invalid id). This matches the friendship-request
// rate-limit (REQ-054) which buckets sentinel-success too: a bucketless
// path is a free enumeration channel.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { room, user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

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
): Promise<{ agent: request.Agent; userId: string }> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

async function insertPublicGroupRoom(name: string): Promise<string> {
  const id = randomUUID();
  await getTestDb()
    .insert(room)
    .values({ id, name, kind: "group", visibility: "public" });
  return id;
}

describe("REQ-026 POST /api/v1/rooms/:id/join rate-limit (60/hour per user)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-026 60 attempts succeed, 61st returns 429 rate_limited", async () => {
    const alice = await registerAgent(app, "r026rl-a@example.com", "r026rl_a");
    // Same room for all 60 — first is 200 joined:true, next 59 are
    // 200 joined:false (idempotent). Every one counts against the bucket.
    const roomId = await insertPublicGroupRoom("r026rl-public");

    for (let i = 0; i < 60; i++) {
      const res = await alice.agent.post(`/api/v1/rooms/${roomId}/join`);
      expect(res.status).toBe(200);
    }

    const blocked = await alice.agent.post(`/api/v1/rooms/${roomId}/join`);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: "rate_limited" });
    expect(typeof blocked.body.retryAfterSec).toBe("number");
    expect(blocked.body.retryAfterSec).toBeGreaterThan(0);
  });

  test("REQ-026 rate-limit runs before room lookup — invalid ids still burn the bucket", async () => {
    // 60 calls against a non-existent room id return 404 but still count;
    // the 61st — even against a real public room — must be 429, proving
    // the limiter sits ahead of the resolve step (§5 ordering).
    const alice = await registerAgent(app, "r026rl-b@example.com", "r026rl_b");
    const realRoomId = await insertPublicGroupRoom("r026rl-real");

    for (let i = 0; i < 60; i++) {
      const res = await alice.agent.post(`/api/v1/rooms/nope-${i}/join`);
      expect(res.status).toBe(404);
    }

    const blocked = await alice.agent.post(`/api/v1/rooms/${realRoomId}/join`);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: "rate_limited" });
  });
});
