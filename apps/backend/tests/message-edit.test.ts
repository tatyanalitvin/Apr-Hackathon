// PATCH /api/v1/rooms/:roomId/messages/:messageId — REQ-110/111/114.
// Author-only edit with a server-stamped `editedAt` timestamp and a
// live `message.edited` broadcast. Deleted messages reject with 410.
//
// Mirrors messages-send.test.ts' agent/room helpers; Redis-backed rate
// limit exercise follows room-patch.test.ts' pre-seed pattern so the
// expensive 61-request loop is avoided.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createClient } from "redis";
import {
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

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

async function sendMessage(
  agent: request.Agent,
  roomId: string,
  body: string,
): Promise<string> {
  const res = await agent
    .post(`/api/v1/rooms/${roomId}/messages`)
    .send({ body });
  if (res.status !== 201) {
    throw new Error(`send failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.id as string;
}

describe("REQ-110 PATCH /api/v1/rooms/:roomId/messages/:messageId edit", () => {
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

  test("REQ-110 author edits own message → 200 + text updated + editedAt set", async () => {
    const alice = await registerAgent(app, "edit-a@example.com", "edit_a");
    await createRoom("r-edit-happy");
    await addMember("r-edit-happy", alice.userId);
    const messageId = await sendMessage(alice.agent, "r-edit-happy", "first draft");

    const res = await alice.agent
      .patch(`/api/v1/rooms/r-edit-happy/messages/${messageId}`)
      .send({ body: "polished" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: messageId,
      roomId: "r-edit-happy",
      authorId: alice.userId,
      body: "polished",
    });
    expect(typeof res.body.editedAt).toBe("string");

    const [row] = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.id, messageId));
    expect(row.body).toBe("polished");
    expect(row.editedAt).not.toBeNull();
    // seq unchanged — watermark discipline (brief §6 non-negotiable 5).
    expect(row.seq).toBe(1n);
  });

  test("REQ-111 successive edits refresh editedAt without changing seq", async () => {
    const alice = await registerAgent(app, "edit-multi@example.com", "edit_multi");
    await createRoom("r-edit-multi");
    await addMember("r-edit-multi", alice.userId);
    const messageId = await sendMessage(alice.agent, "r-edit-multi", "v1");

    const first = await alice.agent
      .patch(`/api/v1/rooms/r-edit-multi/messages/${messageId}`)
      .send({ body: "v2" });
    expect(first.status).toBe(200);
    const firstEditedAt = first.body.editedAt as string;

    // Ensure wall-clock advances at least a millisecond.
    await new Promise((r) => setTimeout(r, 5));

    const second = await alice.agent
      .patch(`/api/v1/rooms/r-edit-multi/messages/${messageId}`)
      .send({ body: "v3" });
    expect(second.status).toBe(200);
    expect(second.body.body).toBe("v3");
    expect(second.body.editedAt).not.toBe(firstEditedAt);
    expect(new Date(second.body.editedAt).getTime()).toBeGreaterThan(
      new Date(firstEditedAt).getTime(),
    );
  });

  test("REQ-114 non-author member → 403, row unchanged", async () => {
    const alice = await registerAgent(app, "edit-auth-a@example.com", "edit_auth_a");
    const bob = await registerAgent(app, "edit-auth-b@example.com", "edit_auth_b");
    await createRoom("r-edit-authz");
    await addMember("r-edit-authz", alice.userId);
    await addMember("r-edit-authz", bob.userId);
    const messageId = await sendMessage(alice.agent, "r-edit-authz", "alice says hi");

    const res = await bob.agent
      .patch(`/api/v1/rooms/r-edit-authz/messages/${messageId}`)
      .send({ body: "hijacked" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "not_message_author" });

    const [row] = await getTestDb()
      .select({ body: message.body, editedAt: message.editedAt })
      .from(message)
      .where(eq(message.id, messageId));
    expect(row.body).toBe("alice says hi");
    expect(row.editedAt).toBeNull();
  });

  test("REQ-114 non-member of the room → 403, no authz oracle", async () => {
    const alice = await registerAgent(app, "edit-nonmem-a@example.com", "edit_nmm_a");
    const eve = await registerAgent(app, "edit-nonmem-e@example.com", "edit_nmm_e");
    await createRoom("r-edit-nonmem");
    await addMember("r-edit-nonmem", alice.userId);
    // Eve is NOT a member.
    const messageId = await sendMessage(alice.agent, "r-edit-nonmem", "members only");

    const res = await eve.agent
      .patch(`/api/v1/rooms/r-edit-nonmem/messages/${messageId}`)
      .send({ body: "leaked" });

    expect(res.status).toBe(403);
  });

  test("REQ-110 no cookie → 401 unauthorized", async () => {
    const alice = await registerAgent(app, "edit-nocookie@example.com", "edit_nck");
    await createRoom("r-edit-nck");
    await addMember("r-edit-nck", alice.userId);
    const messageId = await sendMessage(alice.agent, "r-edit-nck", "hi");

    const res = await request(app.server)
      .patch(`/api/v1/rooms/r-edit-nck/messages/${messageId}`)
      .send({ body: "nope" });
    expect(res.status).toBe(401);
  });

  test("REQ-113 editing a deleted message → 410 gone", async () => {
    const alice = await registerAgent(app, "edit-gone@example.com", "edit_gone");
    await createRoom("r-edit-gone");
    await addMember("r-edit-gone", alice.userId);
    const messageId = await sendMessage(alice.agent, "r-edit-gone", "will vanish");

    const del = await alice.agent.delete(
      `/api/v1/rooms/r-edit-gone/messages/${messageId}`,
    );
    expect(del.status).toBe(204);

    const res = await alice.agent
      .patch(`/api/v1/rooms/r-edit-gone/messages/${messageId}`)
      .send({ body: "resurrect" });
    expect(res.status).toBe(410);
  });

  test("REQ-110 message in a different room → 404", async () => {
    const alice = await registerAgent(app, "edit-wrongroom@example.com", "edit_wr");
    await createRoom("r-edit-wr-a");
    await createRoom("r-edit-wr-b");
    await addMember("r-edit-wr-a", alice.userId);
    await addMember("r-edit-wr-b", alice.userId);
    const messageId = await sendMessage(alice.agent, "r-edit-wr-a", "in A");

    const res = await alice.agent
      .patch(`/api/v1/rooms/r-edit-wr-b/messages/${messageId}`)
      .send({ body: "routed to B" });
    expect(res.status).toBe(404);
  });

  test("REQ-110 invalid body (empty) → 400", async () => {
    const alice = await registerAgent(app, "edit-invalid@example.com", "edit_inv");
    await createRoom("r-edit-inv");
    await addMember("r-edit-inv", alice.userId);
    const messageId = await sendMessage(alice.agent, "r-edit-inv", "orig");

    const res = await alice.agent
      .patch(`/api/v1/rooms/r-edit-inv/messages/${messageId}`)
      .send({ body: "" });
    expect(res.status).toBe(400);
  });

  test("REQ-110 rate limit: pre-seeded bucket → 429 on first attempt", async () => {
    const alice = await registerAgent(app, "edit-rl@example.com", "edit_rl");
    await createRoom("r-edit-rl");
    await addMember("r-edit-rl", alice.userId);
    const messageId = await sendMessage(alice.agent, "r-edit-rl", "orig");

    const c = createClient({ url: env.REDIS_URL });
    await c.connect();
    await c.set(`rate:message-edit:${alice.userId}`, "60");
    await c.expire(`rate:message-edit:${alice.userId}`, 60);
    await c.quit();

    const res = await alice.agent
      .patch(`/api/v1/rooms/r-edit-rl/messages/${messageId}`)
      .send({ body: "blocked" });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "rate_limited" });
  });
});
