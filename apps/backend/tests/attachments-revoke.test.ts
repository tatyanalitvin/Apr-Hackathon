import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-E-REVOKE-GATE / REQ-E-REVOKE-UPLOADER — attachment download gate
// must be `room_member ∧ ¬room_ban`. Binding spec: docs/specs/s2-attachments-enhance.md §4 + §6.
//
// Wave-1 dependency (agent A):
//   - DELETE /api/v1/rooms/:id/members/:userId → kick = INSERT room_ban + DELETE room_member.
//   - POST   /api/v1/rooms/:id/bans           → ban = INSERT room_ban (+ DELETE room_member if was-member).
// See apps/backend/src/routes/rooms.ts:762 / :862.
//
// Test shapes:
//   (1) Kick path 403 — member row gone, ban row present. (Both old + new gate 403.)
//   (2) Kick path 403 — uploader's own file. (Both old + new gate 403.)
//   (3) Load-bearing: room_member row intact AND room_ban row exists.
//       Old `room_member`-only gate returns 200; new gate returns 403.
//       This is the only test that actually distinguishes the two gates.
//   (4) POST /bans path 403.
//   (5) Regression guard — remaining unbanned member still gets 200.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { roomBan, roomMember, user } from "@ai-herders/shared/schema";

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
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

async function createRoomAsOwner(
  app: FastifyInstance,
  email: string,
  username: string,
  name: string,
): Promise<SignedUpAgent & { roomId: string }> {
  const owner = await registerAgent(app, email, username);
  const res = await owner.agent.post("/api/v1/rooms").send({ name });
  if (res.status !== 201) {
    throw new Error(
      `failed to create room ${name}: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return { ...owner, roomId: res.body.id as string };
}

async function joinRoom(target: SignedUpAgent, roomId: string): Promise<void> {
  await target.agent.post(`/api/v1/rooms/${roomId}/join`).expect(200);
}

async function uploadFile(
  agent: request.Agent,
  roomId: string,
): Promise<string> {
  const res = await agent
    .post("/api/v1/attachments")
    .field("roomId", roomId)
    .attach("file", Buffer.from("secret bytes"), {
      filename: "secret.txt",
      contentType: "text/plain",
    });
  if (res.status !== 201) {
    throw new Error(`upload failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.attachmentId;
}

async function banRowExists(roomId: string, userId: string): Promise<boolean> {
  const [row] = await getTestDb()
    .select({ id: roomBan.id })
    .from(roomBan)
    .where(and(eq(roomBan.roomId, roomId), eq(roomBan.userId, userId)))
    .limit(1);
  return !!row;
}

async function memberRowExists(
  roomId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await getTestDb()
    .select({ id: roomMember.id })
    .from(roomMember)
    .where(and(eq(roomMember.roomId, roomId), eq(roomMember.userId, userId)))
    .limit(1);
  return !!row;
}

async function insertBanDirect(
  roomId: string,
  userId: string,
  bannedById: string,
): Promise<void> {
  await getTestDb().insert(roomBan).values({
    id: randomUUID(),
    roomId,
    userId,
    bannedById,
    reason: "test-direct-insert",
  });
}

describe("REQ-E-REVOKE-GATE / REQ-E-REVOKE-UPLOADER — download = member ∧ ¬ban", () => {
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

  test("kick flow — Bob's GET after kick → 403; member row gone, ban row present", async () => {
    const alice = await createRoomAsOwner(
      app,
      "erev-kick-a@example.com",
      "erev_kick_a",
      "ERev Kick",
    );
    const bob = await registerAgent(app, "erev-kick-b@example.com", "erev_kick_b");
    await joinRoom(bob, alice.roomId);

    const attId = await uploadFile(bob.agent, alice.roomId);

    // Sanity — Bob can download before the kick.
    expect(
      (await bob.agent.get(`/api/v1/attachments/${attId}`)).status,
    ).toBe(200);

    const kick = await alice.agent.delete(
      `/api/v1/rooms/${alice.roomId}/members/${bob.userId}`,
    );
    expect(kick.status).toBe(200);

    // Wave-1 invariant: kick writes a ban row AND removes membership.
    expect(await banRowExists(alice.roomId, bob.userId)).toBe(true);
    expect(await memberRowExists(alice.roomId, bob.userId)).toBe(false);

    const res = await bob.agent.get(`/api/v1/attachments/${attId}`);
    expect(res.status).toBe(403);
  });

  test("REQ-E-REVOKE-UPLOADER — uploader's OWN file 403 after kick (§2.6.5)", async () => {
    const alice = await createRoomAsOwner(
      app,
      "erev-own-a@example.com",
      "erev_own_a",
      "ERev Own",
    );
    const bob = await registerAgent(app, "erev-own-b@example.com", "erev_own_b");
    await joinRoom(bob, alice.roomId);

    const bobsFile = await uploadFile(bob.agent, alice.roomId);

    await alice.agent
      .delete(`/api/v1/rooms/${alice.roomId}/members/${bob.userId}`)
      .expect(200);

    const res = await bob.agent.get(`/api/v1/attachments/${bobsFile}`);
    expect(res.status).toBe(403);
  });

  test("REQ-E-REVOKE-GATE (load-bearing) — member row intact + ban row present → 403", async () => {
    // This is the regression test for the NOT-EXISTS branch. Old gate (member-only)
    // returns 200 here; the new gate must return 403.
    const alice = await createRoomAsOwner(
      app,
      "erev-coex-a@example.com",
      "erev_coex_a",
      "ERev Coexist",
    );
    const bob = await registerAgent(app, "erev-coex-b@example.com", "erev_coex_b");
    await joinRoom(bob, alice.roomId);

    const attId = await uploadFile(bob.agent, alice.roomId);

    // Pre-condition: Bob can download.
    expect(
      (await bob.agent.get(`/api/v1/attachments/${attId}`)).status,
    ).toBe(200);

    // Simulate "admin re-added after ban wasn't cleared" — ban row exists,
    // membership intact. No endpoint in wave-1 moderation produces this state
    // directly, so we insert via the test db helper.
    await insertBanDirect(alice.roomId, bob.userId, alice.userId);

    expect(await banRowExists(alice.roomId, bob.userId)).toBe(true);
    expect(await memberRowExists(alice.roomId, bob.userId)).toBe(true);

    const res = await bob.agent.get(`/api/v1/attachments/${attId}`);
    expect(res.status).toBe(403);
  });

  test("REQ-E-REVOKE-GATE POST /bans — ban row present, member row deleted → 403", async () => {
    const alice = await createRoomAsOwner(
      app,
      "erev-post-a@example.com",
      "erev_post_a",
      "ERev Post",
    );
    const bob = await registerAgent(app, "erev-post-b@example.com", "erev_post_b");
    await joinRoom(bob, alice.roomId);

    const attId = await uploadFile(bob.agent, alice.roomId);

    const banRes = await alice.agent
      .post(`/api/v1/rooms/${alice.roomId}/bans`)
      .send({ userId: bob.userId });
    expect(banRes.status).toBe(200);
    expect(await banRowExists(alice.roomId, bob.userId)).toBe(true);
    expect(await memberRowExists(alice.roomId, bob.userId)).toBe(false);

    const res = await bob.agent.get(`/api/v1/attachments/${attId}`);
    expect(res.status).toBe(403);
  });

  test("regression — remaining unbanned member still gets 200", async () => {
    const alice = await createRoomAsOwner(
      app,
      "erev-reg-a@example.com",
      "erev_reg_a",
      "ERev Reg",
    );
    const bob = await registerAgent(app, "erev-reg-b@example.com", "erev_reg_b");
    const carol = await registerAgent(app, "erev-reg-c@example.com", "erev_reg_c");
    await joinRoom(bob, alice.roomId);
    await joinRoom(carol, alice.roomId);

    const attId = await uploadFile(bob.agent, alice.roomId);

    // Kick Bob — Carol (never banned, still member) must keep access.
    await alice.agent
      .delete(`/api/v1/rooms/${alice.roomId}/members/${bob.userId}`)
      .expect(200);

    const res = await carol.agent.get(`/api/v1/attachments/${attId}`);
    expect(res.status).toBe(200);
  });
});
