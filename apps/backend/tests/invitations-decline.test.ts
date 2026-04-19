// REQ-089 R6 — POST /api/v1/invitations/:id/decline.
// Binding: docs/specs/s2-invitations.md §4 R6.
//
// Shape: 200 { declined: true }. Errors:
//   401 unauthenticated
//   404 invitation_not_found
//   403 not_invitee
//   409 invitation_not_pending (already accepted/declined; or expired — R6
//        treats expired as non-pending even if status is literally 'pending')
//
// Side effect: roomInvite.status → 'declined', respondedAt set. Socket fanout
// `room.invitation.declined` → user:{inviterId} is covered by
// invitations-socket.test.ts; this file is HTTP contract + DB state only.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { roomInvite, user } from "@ai-herders/shared/schema";

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

describe("REQ-089 POST /invitations/:id/decline — R6 contract", () => {
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

  test("REQ-089 R6 401 when unauthenticated", async () => {
    const anon = request.agent(app.server);
    const res = await anon.post("/api/v1/invitations/some-id/decline");
    expect(res.status).toBe(401);
  });

  test("REQ-089 R6 404 invitation_not_found", async () => {
    const alice = await registerAgent(app, "r089d_nf@example.com", "r089d_nf");
    const res = await alice.agent.post(
      "/api/v1/invitations/00000000-0000-0000-0000-000000000000/decline",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("invitation_not_found");
  });

  test("REQ-089 R6 403 not_invitee when the inviter tries to decline their own outgoing invite", async () => {
    const alice = await registerAgent(app, "r089d_ni_a@example.com", "r089d_ni_a");
    const bob = await registerAgent(app, "r089d_ni_b@example.com", "r089d_ni_b");
    const roomId = await createPrivateRoom(alice, "Decline NI R089");
    const invitationId = await sendInvite(alice, roomId, "r089d_ni_b");

    const res = await alice.agent.post(
      `/api/v1/invitations/${invitationId}/decline`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_invitee");
    void bob;
  });

  test("REQ-089 R6 403 not_invitee when a third party tries to decline", async () => {
    const alice = await registerAgent(app, "r089d_ni3_a@example.com", "r089d_ni3_a");
    const bob = await registerAgent(app, "r089d_ni3_b@example.com", "r089d_ni3_b");
    const eve = await registerAgent(app, "r089d_ni3_e@example.com", "r089d_ni3_e");
    const roomId = await createPrivateRoom(alice, "Decline NI3 R089");
    const invitationId = await sendInvite(alice, roomId, "r089d_ni3_b");

    const res = await eve.agent.post(
      `/api/v1/invitations/${invitationId}/decline`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_invitee");
    void bob;
  });

  test("REQ-089 R6 happy path — 200 { declined: true }, status='declined', respondedAt set", async () => {
    const alice = await registerAgent(app, "r089d_ok_a@example.com", "r089d_ok_a");
    const bob = await registerAgent(app, "r089d_ok_b@example.com", "r089d_ok_b");
    const roomId = await createPrivateRoom(alice, "Decline OK R089");
    const invitationId = await sendInvite(alice, roomId, "r089d_ok_b");

    const res = await bob.agent.post(
      `/api/v1/invitations/${invitationId}/decline`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ declined: true });

    const [row] = await getTestDb()
      .select({
        status: roomInvite.status,
        respondedAt: roomInvite.respondedAt,
      })
      .from(roomInvite)
      .where(eq(roomInvite.id, invitationId));
    expect(row?.status).toBe("declined");
    expect(row?.respondedAt).not.toBeNull();
  });

  test("REQ-089 R6 409 invitation_not_pending when already declined", async () => {
    const alice = await registerAgent(app, "r089d_2x_a@example.com", "r089d_2x_a");
    const bob = await registerAgent(app, "r089d_2x_b@example.com", "r089d_2x_b");
    const roomId = await createPrivateRoom(alice, "Decline 2X R089");
    const invitationId = await sendInvite(alice, roomId, "r089d_2x_b");

    await bob.agent.post(`/api/v1/invitations/${invitationId}/decline`).expect(200);
    const second = await bob.agent.post(
      `/api/v1/invitations/${invitationId}/decline`,
    );
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("invitation_not_pending");
  });

  test("REQ-089 R6 409 invitation_not_pending when already accepted", async () => {
    const alice = await registerAgent(app, "r089d_acc_a@example.com", "r089d_acc_a");
    const bob = await registerAgent(app, "r089d_acc_b@example.com", "r089d_acc_b");
    const roomId = await createPrivateRoom(alice, "Decline ACC R089");
    const invitationId = await sendInvite(alice, roomId, "r089d_acc_b");

    await bob.agent.post(`/api/v1/invitations/${invitationId}/accept`).expect(200);
    const decline = await bob.agent.post(
      `/api/v1/invitations/${invitationId}/decline`,
    );
    expect(decline.status).toBe(409);
    expect(decline.body.error).toBe("invitation_not_pending");
  });
});
