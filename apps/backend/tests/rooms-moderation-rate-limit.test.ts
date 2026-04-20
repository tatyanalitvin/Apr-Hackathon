import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// Spec: docs/specs/s3-gc-and-moderation-rl.md §4 R1–R3, §6 task 10.
//
// Integration proof that the dual-tier moderation limiter is wired into
// each of the five moderation endpoints (promote/demote/kick/ban/unban).
// Each sub-test uses `flushRedis()` to reset the (userId, roomId) bucket,
// fires 10 allowed calls, and asserts the 11th is 429 with the expected
// `{error:"rate_limited", retryAfterSec}` body shape.
//
// We deliberately don't assert the content of the first 10 responses — some
// endpoints return 200, some 404/409 depending on idempotency + prior state.
// The RL check sits BEFORE DB reads, so bucket consumption is independent
// of response status.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { room, roomMember, user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { MOD_BURST_LIMIT } from "../src/lib/room-moderation-rate-limit";
import { flushRedis, getTestDb } from "./db-helpers";

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
  // Supertest doesn't set Origin/Referer, so csrfPreHandler falls through the
  // "not a browser" branch — no csrf token needed (csrf.ts:141-153).
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

async function seedOwnedRoom(ownerId: string): Promise<string> {
  const id = randomUUID();
  await getTestDb()
    .insert(room)
    .values({ id, name: `r-${id.slice(0, 8)}`, kind: "group", visibility: "public", ownerId });
  await getTestDb()
    .insert(roomMember)
    .values({ id: `${id}-${ownerId}`, roomId: id, userId: ownerId, role: "owner" });
  return id;
}

async function addAsAdmin(roomId: string, userId: string): Promise<void> {
  await getTestDb()
    .insert(roomMember)
    .values({ id: `${roomId}-${userId}`, roomId, userId, role: "admin" });
}

async function addAsMember(roomId: string, userId: string): Promise<void> {
  await getTestDb()
    .insert(roomMember)
    .values({ id: `${roomId}-${userId}`, roomId, userId, role: "member" });
}

describe("rooms moderation rate-limit (R1-R3)", () => {
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

  test("promote endpoint 429s on the 11th call", async () => {
    const owner = await registerAgent(app, "mod-promote@gc.test", "mod_promote");
    const target = await registerAgent(app, "mod-promote-t@gc.test", "mod_promote_t");
    const roomId = await seedOwnedRoom(owner.userId);
    await addAsMember(roomId, target.userId);

    for (let i = 0; i < MOD_BURST_LIMIT; i++) {
      const res = await owner.agent
        .post(`/api/v1/rooms/${roomId}/admins/${target.userId}`)
        ;
      expect(res.status).not.toBe(429);
    }
    const blocked = await owner.agent
      .post(`/api/v1/rooms/${roomId}/admins/${target.userId}`)
      ;
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: "rate_limited" });
    expect(typeof blocked.body.retryAfterSec).toBe("number");
    expect(blocked.body.retryAfterSec).toBeGreaterThan(0);
  });

  test("demote endpoint 429s on the 11th call", async () => {
    const owner = await registerAgent(app, "mod-demote@gc.test", "mod_demote");
    const target = await registerAgent(app, "mod-demote-t@gc.test", "mod_demote_t");
    const roomId = await seedOwnedRoom(owner.userId);
    await addAsAdmin(roomId, target.userId);

    for (let i = 0; i < MOD_BURST_LIMIT; i++) {
      const res = await owner.agent
        .delete(`/api/v1/rooms/${roomId}/admins/${target.userId}`)
        ;
      expect(res.status).not.toBe(429);
    }
    const blocked = await owner.agent
      .delete(`/api/v1/rooms/${roomId}/admins/${target.userId}`)
      ;
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: "rate_limited" });
  });

  test("kick endpoint 429s on the 11th call", async () => {
    const owner = await registerAgent(app, "mod-kick@gc.test", "mod_kick");
    const target = await registerAgent(app, "mod-kick-t@gc.test", "mod_kick_t");
    const roomId = await seedOwnedRoom(owner.userId);
    await addAsMember(roomId, target.userId);

    for (let i = 0; i < MOD_BURST_LIMIT; i++) {
      const res = await owner.agent
        .delete(`/api/v1/rooms/${roomId}/members/${target.userId}`)
        ;
      expect(res.status).not.toBe(429);
    }
    const blocked = await owner.agent
      .delete(`/api/v1/rooms/${roomId}/members/${target.userId}`)
      ;
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: "rate_limited" });
  });

  test("ban endpoint 429s on the 11th call", async () => {
    const owner = await registerAgent(app, "mod-ban@gc.test", "mod_ban");
    const target = await registerAgent(app, "mod-ban-t@gc.test", "mod_ban_t");
    const roomId = await seedOwnedRoom(owner.userId);

    for (let i = 0; i < MOD_BURST_LIMIT; i++) {
      const res = await owner.agent
        .post(`/api/v1/rooms/${roomId}/bans`)
        
        .send({ userId: target.userId });
      expect(res.status).not.toBe(429);
    }
    const blocked = await owner.agent
      .post(`/api/v1/rooms/${roomId}/bans`)
      
      .send({ userId: target.userId });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: "rate_limited" });
  });

  test("unban endpoint 429s on the 11th call", async () => {
    const owner = await registerAgent(app, "mod-unban@gc.test", "mod_unban");
    const target = await registerAgent(app, "mod-unban-t@gc.test", "mod_unban_t");
    const roomId = await seedOwnedRoom(owner.userId);

    for (let i = 0; i < MOD_BURST_LIMIT; i++) {
      const res = await owner.agent
        .delete(`/api/v1/rooms/${roomId}/bans/${target.userId}`)
        ;
      expect(res.status).not.toBe(429);
    }
    const blocked = await owner.agent
      .delete(`/api/v1/rooms/${roomId}/bans/${target.userId}`)
      ;
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: "rate_limited" });
  });
});
