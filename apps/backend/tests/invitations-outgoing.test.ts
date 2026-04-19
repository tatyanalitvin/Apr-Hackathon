// REQ-089 GET /rooms/:id/invitations (outgoing list for a room).
// Binding: docs/specs/s2-invitations.md §6 UI (InvitationsTab list).
//
// Shape: { invitations: Array<{ id, inviterUsername, inviteeUsername,
// createdAt, expiresAt }> }. Filter: status='pending' AND expiresAt > now().
// Ordered by createdAt DESC. 403 for non-members (same gate as R3 send).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { flushRedis, getTestDb, getTestPool } from "./db-helpers";

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

async function createPrivateRoom(owner: SignedUpAgent, name: string): Promise<string> {
  const res = await owner.agent
    .post("/api/v1/rooms")
    .send({ name, visibility: "private" })
    .expect(201);
  return res.body.id as string;
}

async function sendInvite(
  inviter: SignedUpAgent,
  roomId: string,
  inviteeUsername: string,
): Promise<string> {
  const res = await inviter.agent
    .post(`/api/v1/rooms/${roomId}/invitations`)
    .send({ inviteeUsername })
    .expect(201);
  return res.body.invitationId as string;
}

describe("REQ-089 GET /rooms/:id/invitations — outgoing per-room list", () => {
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

  test("401 when unauthenticated", async () => {
    const anon = request.agent(app.server);
    const res = await anon.get("/api/v1/rooms/some-id/invitations");
    expect(res.status).toBe(401);
  });

  test("404 room_not_found", async () => {
    const alice = await registerAgent(app, "r089o_nf@example.com", "r089o_nf");
    const res = await alice.agent.get(
      "/api/v1/rooms/00000000-0000-0000-0000-000000000000/invitations",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("room_not_found");
  });

  test("403 not_a_member when caller is not in the room", async () => {
    const alice = await registerAgent(app, "r089o_nm_a@example.com", "r089o_nm_a");
    const eve = await registerAgent(app, "r089o_nm_e@example.com", "r089o_nm_e");
    const roomId = await createPrivateRoom(alice, "Out NM R089");

    const res = await eve.agent.get(`/api/v1/rooms/${roomId}/invitations`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_a_member");
  });

  test("200 lists pending outgoing invites with inviter + invitee usernames, DESC by createdAt", async () => {
    const alice = await registerAgent(app, "r089o_ok_a@example.com", "r089o_ok_a");
    const bob = await registerAgent(app, "r089o_ok_b@example.com", "r089o_ok_b");
    const carol = await registerAgent(app, "r089o_ok_c@example.com", "r089o_ok_c");
    const roomId = await createPrivateRoom(alice, "Out OK R089");

    const invite1 = await sendInvite(alice, roomId, "r089o_ok_b");
    await new Promise((r) => setTimeout(r, 20));
    const invite2 = await sendInvite(alice, roomId, "r089o_ok_c");

    const res = await alice.agent.get(`/api/v1/rooms/${roomId}/invitations`);
    expect(res.status).toBe(200);
    expect(res.body.invitations).toHaveLength(2);
    // Most recent first.
    expect(res.body.invitations[0].id).toBe(invite2);
    expect(res.body.invitations[0].inviteeUsername).toBe("r089o_ok_c");
    expect(res.body.invitations[0].inviterUsername).toBe("r089o_ok_a");
    expect(res.body.invitations[1].id).toBe(invite1);
    expect(res.body.invitations[1].inviteeUsername).toBe("r089o_ok_b");
    void bob.userId;
    void carol.userId;
  });

  test("200 excludes expired-but-still-'pending' rows (R8 lazy-GC consistency)", async () => {
    const alice = await registerAgent(app, "r089o_exp_a@example.com", "r089o_exp_a");
    const bob = await registerAgent(app, "r089o_exp_b@example.com", "r089o_exp_b");
    const roomId = await createPrivateRoom(alice, "Out EXP R089");
    const invite = await sendInvite(alice, roomId, "r089o_exp_b");

    await getTestPool().query(
      `UPDATE room_invite SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [invite],
    );

    const res = await alice.agent.get(`/api/v1/rooms/${roomId}/invitations`);
    expect(res.status).toBe(200);
    expect(res.body.invitations).toHaveLength(0);
    void bob.userId;
  });
});
