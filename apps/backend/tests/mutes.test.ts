// REQ-123 — PUT /api/v1/rooms/:id/mute.
//
// Sets `room_member.mutedUntil` for the caller. ISO timestamp = muted until
// that moment (past → effectively unmuted at read time). null = unmuted.
// Only room members can post (403 for non-members). Rate-limit 30/min.
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

// Distinguishes "no row" (undefined) from "row with mutedUntil IS NULL" (null).
async function readMutedUntil(
  roomId: string,
  userId: string,
): Promise<Date | null | undefined> {
  const [row] = await getTestDb()
    .select({ mutedUntil: roomMember.mutedUntil })
    .from(roomMember)
    .where(and(eq(roomMember.roomId, roomId), eq(roomMember.userId, userId)))
    .limit(1);
  if (!row) return undefined;
  return row.mutedUntil;
}

describe("REQ-123 PUT /api/v1/rooms/:id/mute", () => {
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
    const roomId = await insertRoom("r123-anon");
    const res = await request(app.server)
      .put(`/api/v1/rooms/${roomId}/mute`)
      .send({ mutedUntil: null });
    expect(res.status).toBe(401);
  });

  test("sets mutedUntil to a future ISO timestamp", async () => {
    const alice = await registerAgent(app, "r123a@example.com", "r123_a");
    const roomId = await insertRoom("r123-mute");
    await addMember(roomId, alice.userId);

    const until = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    const res = await alice.agent
      .put(`/api/v1/rooms/${roomId}/mute`)
      .send({ mutedUntil: until });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ roomId, mutedUntil: until });

    const stored = await readMutedUntil(roomId, alice.userId);
    expect(stored).toBeInstanceOf(Date);
    expect((stored as Date).toISOString()).toBe(until);
  });

  test("null mutedUntil clears the row (unmute)", async () => {
    const alice = await registerAgent(app, "r123b@example.com", "r123_b");
    const roomId = await insertRoom("r123-unmute");
    await addMember(roomId, alice.userId);

    const until = new Date(Date.now() + 3600_000).toISOString();
    await alice.agent
      .put(`/api/v1/rooms/${roomId}/mute`)
      .send({ mutedUntil: until })
      .expect(200);

    const unmute = await alice.agent
      .put(`/api/v1/rooms/${roomId}/mute`)
      .send({ mutedUntil: null });
    expect(unmute.status).toBe(200);
    expect(unmute.body).toMatchObject({ roomId, mutedUntil: null });
    expect(await readMutedUntil(roomId, alice.userId)).toBeNull();
  });

  test("non-member → 403 forbidden", async () => {
    const alice = await registerAgent(app, "r123c@example.com", "r123_c");
    const bob = await registerAgent(app, "r123c2@example.com", "r123_c2");
    const roomId = await insertRoom("r123-foreign");
    await addMember(roomId, bob.userId);

    const res = await alice.agent
      .put(`/api/v1/rooms/${roomId}/mute`)
      .send({ mutedUntil: null });
    expect(res.status).toBe(403);
  });

  test("malformed body (non-ISO string) → 400", async () => {
    const alice = await registerAgent(app, "r123v@example.com", "r123_v");
    const roomId = await insertRoom("r123-validation");
    await addMember(roomId, alice.userId);

    const res = await alice.agent
      .put(`/api/v1/rooms/${roomId}/mute`)
      .send({ mutedUntil: "not-a-date" });
    expect(res.status).toBe(400);
  });

  test("rate-limit — 31st PUT in 60s → 429", async () => {
    const alice = await registerAgent(app, "r123rl@example.com", "r123_rl");
    const roomId = await insertRoom("r123-rl");
    await addMember(roomId, alice.userId);

    for (let i = 0; i < 30; i++) {
      const ok = await alice.agent
        .put(`/api/v1/rooms/${roomId}/mute`)
        .send({ mutedUntil: null });
      expect(ok.status).toBe(200);
    }
    const denied = await alice.agent
      .put(`/api/v1/rooms/${roomId}/mute`)
      .send({ mutedUntil: null });
    expect(denied.status).toBe(429);
    expect(denied.body).toMatchObject({ error: "rate_limited" });
    expect(typeof denied.body.retryAfterSec).toBe("number");
  });
});
