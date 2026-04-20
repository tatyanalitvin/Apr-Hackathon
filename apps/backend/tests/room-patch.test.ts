import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-087 integration tests for PATCH /api/v1/rooms/:id (rename).
// Creator-only authz (room.ownerId === user.id). DM rooms rejected.
// Rate-limit 10/hr/user (shares the auth → rate-limit → zod order pattern).
//
// See: apps/backend/src/routes/rooms.ts — additive, non-conflicting with
// s1-rooms' POST/DELETE-leave handlers.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { eq } from "drizzle-orm";
import { message, messageSeq, room, roomMember, user } from "@ai-herders/shared/schema";

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
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

async function createRoomAsOwner(
  app: FastifyInstance,
  email: string,
  username: string,
  name: string,
): Promise<{ agent: request.Agent; userId: string; roomId: string }> {
  const owner = await registerAgent(app, email, username);
  const res = await owner.agent.post("/api/v1/rooms").send({ name });
  if (res.status !== 201) {
    throw new Error(`failed to create room ${name}: ${res.status}`);
  }
  return { ...owner, roomId: res.body.id as string };
}

describe("REQ-087 PATCH /api/v1/rooms/:id rename", () => {
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

  test("REQ-087 no cookie → 401", async () => {
    const res = await request(app.server)
      .patch("/api/v1/rooms/some-room")
      .send({ name: "anything" });
    expect(res.status).toBe(401);
  });

  test("REQ-087 owner renames → 200 + updated row", async () => {
    const alice = await createRoomAsOwner(
      app,
      "r087o@example.com",
      "r087_o",
      "R087 Original",
    );
    const res = await alice.agent
      .patch(`/api/v1/rooms/${alice.roomId}`)
      .send({ name: "R087 Renamed" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: alice.roomId,
      name: "R087 Renamed",
      ownerId: alice.userId,
    });
    const [row] = await getTestDb()
      .select({ name: room.name })
      .from(room)
      .where(eq(room.id, alice.roomId));
    expect(row?.name).toBe("R087 Renamed");
  });

  test("REQ-087 non-owner → 403, row unchanged", async () => {
    const alice = await createRoomAsOwner(
      app,
      "r087na@example.com",
      "r087_na",
      "R087 Not Yours",
    );
    const bob = await registerAgent(app, "r087nb@example.com", "r087_nb");
    // Bob joins the room but doesn't own it.
    await bob.agent.post(`/api/v1/rooms/${alice.roomId}/join`).expect(200);

    const res = await bob.agent
      .patch(`/api/v1/rooms/${alice.roomId}`)
      .send({ name: "R087 Hijacked" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "not_room_owner" });

    const [row] = await getTestDb()
      .select({ name: room.name })
      .from(room)
      .where(eq(room.id, alice.roomId));
    expect(row?.name).toBe("R087 Not Yours");
  });

  test("REQ-087 room not found → 404", async () => {
    const alice = await registerAgent(app, "r087nf@example.com", "r087_nf");
    const res = await alice.agent
      .patch("/api/v1/rooms/00000000-0000-0000-0000-deadbeef0000")
      .send({ name: "R087 Ghost" });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "room_not_found" });
  });

  test("REQ-087 DM rename rejected → 403", async () => {
    // Mint a kind='dm' room directly; the DM creation flow requires a
    // friendship precondition that would be noise for this guard test.
    const alice = await registerAgent(app, "r087da@example.com", "r087_da");
    const barry = await registerAgent(app, "r087db@example.com", "r087_db");

    const [lo, hi] =
      alice.userId < barry.userId
        ? [alice.userId, barry.userId]
        : [barry.userId, alice.userId];
    const dmRoomId = randomUUID();
    await getTestDb().insert(room).values({
      id: dmRoomId,
      name: null,
      kind: "dm",
      visibility: "private",
      ownerId: alice.userId,
      dmPairKey: `${lo}:${hi}`,
    });

    const res = await alice.agent
      .patch(`/api/v1/rooms/${dmRoomId}`)
      .send({ name: "R087 DM Rename" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "cannot_modify_dm_via_this_route" });
  });

  test("REQ-087 invalid body (name too short) → 400, row unchanged", async () => {
    const alice = await createRoomAsOwner(
      app,
      "r087v@example.com",
      "r087_v",
      "R087 Validate",
    );
    const res = await alice.agent
      .patch(`/api/v1/rooms/${alice.roomId}`)
      .send({ name: "x" });
    expect(res.status).toBe(400);

    const [row] = await getTestDb()
      .select({ name: room.name })
      .from(room)
      .where(eq(room.id, alice.roomId));
    expect(row?.name).toBe("R087 Validate");
  });

  test("REQ-087 rate limit: 10 renames succeed, 11th → 429", async () => {
    const alice = await createRoomAsOwner(
      app,
      "r087r@example.com",
      "r087_r",
      "R087 RL Original",
    );
    for (let i = 0; i < 10; i++) {
      const ok = await alice.agent
        .patch(`/api/v1/rooms/${alice.roomId}`)
        .send({ name: `R087 RL ${i}` });
      expect(ok.status).toBe(200);
    }
    const denied = await alice.agent
      .patch(`/api/v1/rooms/${alice.roomId}`)
      .send({ name: "R087 RL Over" });
    expect(denied.status).toBe(429);
    expect(denied.body).toMatchObject({ error: "rate_limited" });
    expect(typeof denied.body.retryAfterSec).toBe("number");
    expect(denied.body.retryAfterSec).toBeGreaterThan(0);
  });

  test("REQ-087 rate limit: pre-seeded bucket → denied on first attempt", async () => {
    const alice = await createRoomAsOwner(
      app,
      "r087rp@example.com",
      "r087_rp",
      "R087 RL Preseed",
    );
    const c = createClient({ url: env.REDIS_URL });
    await c.connect();
    await c.set(`rate:room-patch:${alice.userId}`, "10");
    await c.expire(`rate:room-patch:${alice.userId}`, 60 * 60);
    await c.quit();

    const res = await alice.agent
      .patch(`/api/v1/rooms/${alice.roomId}`)
      .send({ name: "R087 RL Blocked" });
    expect(res.status).toBe(429);
  });
});
