// REQ-089 integration tests — POST /api/v1/rooms/:id/invitations.
// Binding spec: docs/specs/s2-invitations.md §4 R3.
//
// Ordering (binding): auth → 404 room → 403 not_a_member → (private) 403
// forbidden_role → 404 invitee_not_found → 409 already_member → 403
// invitee_banned → 409 invite_pending → INSERT + emit + 201. The emit assertion
// lives in invitations-socket.test.ts to keep this file HTTP-only.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { roomBan, roomInvite, roomMember, user } from "@ai-herders/shared/schema";

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

async function createRoom(
  caller: SignedUpAgent,
  name: string,
  visibility: "public" | "private",
): Promise<string> {
  const res = await caller.agent
    .post("/api/v1/rooms")
    .send({ name, visibility })
    .expect(201);
  return res.body.id as string;
}

async function addMember(
  roomId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "member",
): Promise<void> {
  await getTestDb().insert(roomMember).values({
    id: randomUUID(),
    roomId,
    userId,
    role,
    joinedAt: new Date(),
  });
}

describe("REQ-089 POST /rooms/:id/invitations — R3 ordering + effects", () => {
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

  test("REQ-089 R3 401 when unauthenticated", async () => {
    const anon = request.agent(app.server);
    const res = await anon
      .post(`/api/v1/rooms/${randomUUID()}/invitations`)
      .send({ inviteeUsername: "nobody" });
    expect(res.status).toBe(401);
  });

  test("REQ-089 R3 404 when room does not exist", async () => {
    const alice = await registerAgent(app, "r089a@example.com", "r089_a");
    const res = await alice.agent
      .post(`/api/v1/rooms/${randomUUID()}/invitations`)
      .send({ inviteeUsername: "ghost" });
    expect(res.status).toBe(404);
  });

  test("REQ-089 R3 403 not_a_member when caller is not in room_member", async () => {
    const alice = await registerAgent(app, "r089nm_a@example.com", "r089_nm_a");
    const bob = await registerAgent(app, "r089nm_b@example.com", "r089_nm_b");
    const carol = await registerAgent(app, "r089nm_c@example.com", "r089_nm_c");
    void carol;
    const roomId = await createRoom(alice, "NM Room R089", "private");

    const res = await bob.agent
      .post(`/api/v1/rooms/${roomId}/invitations`)
      .send({ inviteeUsername: "r089_nm_c" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_a_member");
  });

  test("REQ-089 R3 403 forbidden_role when private-room caller is a plain member", async () => {
    const alice = await registerAgent(app, "r089fr_a@example.com", "r089_fr_a");
    const bob = await registerAgent(app, "r089fr_b@example.com", "r089_fr_b");
    const carol = await registerAgent(app, "r089fr_c@example.com", "r089_fr_c");
    void carol;
    const roomId = await createRoom(alice, "FR Room R089", "private");
    await addMember(roomId, bob.userId, "member");

    const res = await bob.agent
      .post(`/api/v1/rooms/${roomId}/invitations`)
      .send({ inviteeUsername: "r089_fr_c" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden_role");
  });

  test("REQ-089 R3 private-room admin CAN invite (forbidden_role gate is owner OR admin)", async () => {
    const alice = await registerAgent(app, "r089ad_a@example.com", "r089_ad_a");
    const bob = await registerAgent(app, "r089ad_b@example.com", "r089_ad_b");
    const carol = await registerAgent(app, "r089ad_c@example.com", "r089_ad_c");
    void carol;
    const roomId = await createRoom(alice, "Admin Room R089", "private");
    await addMember(roomId, bob.userId, "admin");

    const res = await bob.agent
      .post(`/api/v1/rooms/${roomId}/invitations`)
      .send({ inviteeUsername: "r089_ad_c" });
    expect(res.status).toBe(201);
  });

  test("REQ-089 R3 (Q1 divergence) public-room plain member MAY invite", async () => {
    const alice = await registerAgent(app, "r089pu_a@example.com", "r089_pu_a");
    const bob = await registerAgent(app, "r089pu_b@example.com", "r089_pu_b");
    const carol = await registerAgent(app, "r089pu_c@example.com", "r089_pu_c");
    void carol;
    const roomId = await createRoom(alice, "Pub Room R089", "public");
    await addMember(roomId, bob.userId, "member");

    const res = await bob.agent
      .post(`/api/v1/rooms/${roomId}/invitations`)
      .send({ inviteeUsername: "r089_pu_c" });
    expect(res.status).toBe(201);
  });

  test("REQ-089 R3 404 invitee_not_found when username does not exist", async () => {
    const alice = await registerAgent(app, "r089nf@example.com", "r089_nf");
    const roomId = await createRoom(alice, "NF Room R089", "private");

    const res = await alice.agent
      .post(`/api/v1/rooms/${roomId}/invitations`)
      .send({ inviteeUsername: "does_not_exist_xyz" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("invitee_not_found");
  });

  test("REQ-089 R3 409 invitee_already_member", async () => {
    const alice = await registerAgent(app, "r089am_a@example.com", "r089_am_a");
    const bob = await registerAgent(app, "r089am_b@example.com", "r089_am_b");
    const roomId = await createRoom(alice, "AM Room R089", "private");
    await addMember(roomId, bob.userId, "member");

    const res = await alice.agent
      .post(`/api/v1/rooms/${roomId}/invitations`)
      .send({ inviteeUsername: "r089_am_b" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invitee_already_member");
  });

  test("REQ-089 R3 403 invitee_banned when room_ban row exists", async () => {
    const alice = await registerAgent(app, "r089bn_a@example.com", "r089_bn_a");
    const bob = await registerAgent(app, "r089bn_b@example.com", "r089_bn_b");
    const roomId = await createRoom(alice, "Ban Room R089", "private");
    await getTestDb().insert(roomBan).values({
      id: randomUUID(),
      roomId,
      userId: bob.userId,
      bannedById: alice.userId,
      reason: "test",
    });

    const res = await alice.agent
      .post(`/api/v1/rooms/${roomId}/invitations`)
      .send({ inviteeUsername: "r089_bn_b" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invitee_banned");
  });

  test("REQ-089 R3 409 invite_pending on duplicate pending row", async () => {
    const alice = await registerAgent(app, "r089dp_a@example.com", "r089_dp_a");
    const bob = await registerAgent(app, "r089dp_b@example.com", "r089_dp_b");
    const roomId = await createRoom(alice, "Dup Room R089", "private");

    const first = await alice.agent
      .post(`/api/v1/rooms/${roomId}/invitations`)
      .send({ inviteeUsername: "r089_dp_b" });
    expect(first.status).toBe(201);

    const second = await alice.agent
      .post(`/api/v1/rooms/${roomId}/invitations`)
      .send({ inviteeUsername: "r089_dp_b" });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("invite_pending");
  });

  test("REQ-089 R3 happy path inserts pending row with 14d expiry and returns 201", async () => {
    const alice = await registerAgent(app, "r089hp_a@example.com", "r089_hp_a");
    const bob = await registerAgent(app, "r089hp_b@example.com", "r089_hp_b");
    const roomId = await createRoom(alice, "Happy Room R089", "private");

    const before = Date.now();
    const res = await alice.agent
      .post(`/api/v1/rooms/${roomId}/invitations`)
      .send({ inviteeUsername: "r089_hp_b" });
    expect(res.status).toBe(201);
    expect(typeof res.body.invitationId).toBe("string");
    expect(typeof res.body.expiresAt).toBe("string");

    const [row] = await getTestDb()
      .select()
      .from(roomInvite)
      .where(
        and(eq(roomInvite.roomId, roomId), eq(roomInvite.inviteeId, bob.userId)),
      );
    expect(row).toBeDefined();
    expect(row?.status).toBe("pending");
    expect(row?.inviterId).toBe(alice.userId);
    expect(row?.expiresAt).toBeInstanceOf(Date);
    const ttlMs = (row!.expiresAt as Date).getTime() - before;
    // REQ-089a — 14d default. Tolerance window covers clock drift + round-trip.
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    expect(ttlMs).toBeGreaterThan(fourteenDaysMs - 5 * 60 * 1000);
    expect(ttlMs).toBeLessThan(fourteenDaysMs + 5 * 60 * 1000);
  });
});
