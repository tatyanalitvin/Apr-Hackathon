// REQ-120 — POST /api/v1/rooms/:id/read.
//
// Updates the caller's `room_member.lastReadSeq` for that room. Idempotent:
// re-posting the same value is a no-op. Only room members can post
// (403 for non-members). Rate-limited liberally (120/min/user) — this fires
// on every room-open / scroll-to-bottom.
//
// Binding brief: .human/S2_UNREAD_MUTE_AGENT_BRIEF.md §1a.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { room, roomMember, user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
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

async function insertRoom(name: string): Promise<string> {
  const id = randomUUID();
  await getTestDb()
    .insert(room)
    .values({ id, name, kind: "group", visibility: "public" });
  return id;
}

async function addMember(roomId: string, userId: string): Promise<void> {
  await getTestDb()
    .insert(roomMember)
    .values({ id: randomUUID(), roomId, userId });
}

async function readLastReadSeq(
  roomId: string,
  userId: string,
): Promise<bigint | null> {
  const [row] = await getTestDb()
    .select({ lastReadSeq: roomMember.lastReadSeq })
    .from(roomMember)
    .where(and(eq(roomMember.roomId, roomId), eq(roomMember.userId, userId)))
    .limit(1);
  return row?.lastReadSeq ?? null;
}

describe("REQ-120 POST /api/v1/rooms/:id/read", () => {
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

  test("no cookie → 401", async () => {
    const roomId = await insertRoom("r120-anon");
    const res = await request(app.server)
      .post(`/api/v1/rooms/${roomId}/read`)
      .send({ lastReadSeq: "5" });
    expect(res.status).toBe(401);
  });

  test("happy path — member posts lastReadSeq, row updated", async () => {
    const alice = await registerAgent(app, "r120a@example.com", "r120_a");
    const roomId = await insertRoom("r120-happy");
    await addMember(roomId, alice.userId);

    const res = await alice.agent
      .post(`/api/v1/rooms/${roomId}/read`)
      .send({ lastReadSeq: "7" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lastReadSeq: "7" });

    const stored = await readLastReadSeq(roomId, alice.userId);
    expect(stored).toBe(7n);
  });

  test("idempotent — posting the same seq twice keeps the row unchanged", async () => {
    const alice = await registerAgent(app, "r120b@example.com", "r120_b");
    const roomId = await insertRoom("r120-idem");
    await addMember(roomId, alice.userId);

    await alice.agent
      .post(`/api/v1/rooms/${roomId}/read`)
      .send({ lastReadSeq: "12" })
      .expect(200);
    const res = await alice.agent
      .post(`/api/v1/rooms/${roomId}/read`)
      .send({ lastReadSeq: "12" });
    expect(res.status).toBe(200);
    expect(await readLastReadSeq(roomId, alice.userId)).toBe(12n);
  });

  test("non-member → 403 forbidden", async () => {
    const alice = await registerAgent(app, "r120c@example.com", "r120_c");
    const bob = await registerAgent(app, "r120c2@example.com", "r120_c2");
    const roomId = await insertRoom("r120-foreign");
    await addMember(roomId, bob.userId);

    const res = await alice.agent
      .post(`/api/v1/rooms/${roomId}/read`)
      .send({ lastReadSeq: "1" });
    expect(res.status).toBe(403);
    expect(await readLastReadSeq(roomId, alice.userId)).toBeNull();
  });

  test("rate-limit — 121st POST in 60s → 429", async () => {
    const alice = await registerAgent(app, "r120rl@example.com", "r120_rl");
    const roomId = await insertRoom("r120-rl");
    await addMember(roomId, alice.userId);

    for (let i = 0; i < 120; i++) {
      const ok = await alice.agent
        .post(`/api/v1/rooms/${roomId}/read`)
        .send({ lastReadSeq: String(i + 1) });
      expect(ok.status).toBe(200);
    }
    const denied = await alice.agent
      .post(`/api/v1/rooms/${roomId}/read`)
      .send({ lastReadSeq: "121" });
    expect(denied.status).toBe(429);
    expect(denied.body).toMatchObject({ error: "rate_limited" });
    expect(typeof denied.body.retryAfterSec).toBe("number");
  });

  test("malformed body (missing lastReadSeq) → 400", async () => {
    const alice = await registerAgent(app, "r120v@example.com", "r120_v");
    const roomId = await insertRoom("r120-validation");
    await addMember(roomId, alice.userId);

    const res = await alice.agent
      .post(`/api/v1/rooms/${roomId}/read`)
      .send({});
    expect(res.status).toBe(400);
  });
});
