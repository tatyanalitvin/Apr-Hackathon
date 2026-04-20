import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-033 — clientMessageId idempotency (R5).
//
// Decision: spec §8 Q1 option (a) — Postgres column + partial unique index
// on (roomId, clientMessageId) WHERE clientMessageId IS NOT NULL. Dedup runs
// inside the same transaction as the seq allocator via ON CONFLICT DO NOTHING;
// on conflict we SELECT the pre-existing row by (roomId, clientMessageId).
// Durability matches REQ-036 (survives restart); Redis-flush immunity.
//
// Acceptance test comes directly from spec §6 step 10:
//   "same clientMessageId sent twice → same message.id + same seq + one row".

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

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

async function registerAgent(app: FastifyInstance, email: string, username: string) {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

async function createRoom(roomId: string): Promise<void> {
  const db = getTestDb();
  await db.insert(room).values({
    id: roomId,
    name: roomId,
    kind: "group",
    visibility: "public",
    ownerId: null,
  });
  await db.insert(messageSeq).values({ roomId, seq: 0n });
}

async function addMember(roomId: string, userId: string): Promise<void> {
  await getTestDb()
    .insert(roomMember)
    .values({ id: `${roomId}-${userId}`, roomId, userId, role: "member" });
}

describe("REQ-033 clientMessageId idempotency", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-033 same clientMessageId twice → same id + same seq + one row", async () => {
    const { agent, userId } = await registerAgent(app, "idemp-a@example.com", "idemp_a");
    const roomId = "r-idemp-a";
    await createRoom(roomId);
    await addMember(roomId, userId);

    const clientMessageId = "11111111-1111-4111-8111-111111111111";

    const first = await agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "first attempt", clientMessageId });
    expect(first.status).toBe(201);

    const second = await agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "second attempt (should be ignored)", clientMessageId });
    expect(second.status).toBe(201);

    expect(second.body.id).toBe(first.body.id);
    expect(second.body.seq).toBe(first.body.seq);
    // The original body wins — retries never overwrite prior content.
    expect(second.body.body).toBe("first attempt");

    const rows = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.roomId, roomId));
    expect(rows).toHaveLength(1);
    expect(rows[0].seq).toBe(1n);
  });

  test("REQ-033 different clientMessageIds → two rows, two seqs", async () => {
    const { agent, userId } = await registerAgent(app, "idemp-b@example.com", "idemp_b");
    const roomId = "r-idemp-b";
    await createRoom(roomId);
    await addMember(roomId, userId);

    const a = await agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "one", clientMessageId: "22222222-2222-4222-8222-222222222222" });
    const b = await agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "two", clientMessageId: "33333333-3333-4333-8333-333333333333" });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
    expect(a.body.seq).toBe("1");
    expect(b.body.seq).toBe("2");
  });

  test("REQ-033 missing clientMessageId → no dedup, each POST creates a row", async () => {
    const { agent, userId } = await registerAgent(app, "idemp-c@example.com", "idemp_c");
    const roomId = "r-idemp-c";
    await createRoom(roomId);
    await addMember(roomId, userId);

    // Critical: two NULL clientMessageId rows must NOT collide on the unique
    // index. The partial `WHERE client_message_id IS NOT NULL` enforces this.
    const a = await agent.post(`/api/v1/rooms/${roomId}/messages`).send({ body: "a" });
    const b = await agent.post(`/api/v1/rooms/${roomId}/messages`).send({ body: "b" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.seq).toBe("1");
    expect(b.body.seq).toBe("2");
  });

  test("REQ-033 same clientMessageId in different rooms → independent inserts", async () => {
    const { agent, userId } = await registerAgent(app, "idemp-d@example.com", "idemp_d");
    const r1 = "r-idemp-d1";
    const r2 = "r-idemp-d2";
    await createRoom(r1);
    await createRoom(r2);
    await addMember(r1, userId);
    await addMember(r2, userId);

    const cid = "44444444-4444-4444-8444-444444444444";
    const a = await agent.post(`/api/v1/rooms/${r1}/messages`).send({ body: "x", clientMessageId: cid });
    const b = await agent.post(`/api/v1/rooms/${r2}/messages`).send({ body: "y", clientMessageId: cid });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
    // Each room has its own seq stream.
    expect(a.body.seq).toBe("1");
    expect(b.body.seq).toBe("1");
  });

  test("REQ-033 invalid (non-UUID) clientMessageId → 400 validation", async () => {
    const { agent, userId } = await registerAgent(app, "idemp-e@example.com", "idemp_e");
    const roomId = "r-idemp-e";
    await createRoom(roomId);
    await addMember(roomId, userId);

    const res = await agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "hi", clientMessageId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });
});
