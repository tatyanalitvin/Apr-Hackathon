import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-089 R7 — DELETE /api/v1/invitations/:id (inviter cancel).
// Binding: docs/specs/s2-invitations.md §4 R7.
//
// Shape: 200 { cancelled: true }. Errors:
//   401 unauthenticated
//   404 invitation_not_found
//   403 not_inviter (NOT not_invitee — R7 checks inviterId, asymmetric with R5/R6)
//   409 invitation_not_pending
//
// R7 reuses the 'declined' terminal status (§4 R7 binding) — there is no
// separate 'cancelled' status in the enum. Side-effect: roomInvite.status →
// 'declined'. Socket fanout `room.invitation.declined` → user:{inviteeId}
// (inverted audience vs R6; binding asymmetry) is covered by
// invitations-socket.test.ts.

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
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
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

describe("REQ-089 DELETE /invitations/:id — R7 inviter-cancel contract", () => {
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

  test("REQ-089 R7 401 when unauthenticated", async () => {
    const anon = request.agent(app.server);
    const res = await anon.delete("/api/v1/invitations/some-id");
    expect(res.status).toBe(401);
  });

  test("REQ-089 R7 404 invitation_not_found", async () => {
    const alice = await registerAgent(app, "r089c_nf@example.com", "r089c_nf");
    const res = await alice.agent.delete(
      "/api/v1/invitations/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("invitation_not_found");
  });

  test("REQ-089 R7 403 not_inviter when the invitee tries to DELETE (asymmetric with R5/R6)", async () => {
    const alice = await registerAgent(app, "r089c_ni_a@example.com", "r089c_ni_a");
    const bob = await registerAgent(app, "r089c_ni_b@example.com", "r089c_ni_b");
    const roomId = await createPrivateRoom(alice, "Cancel NI R089");
    const invitationId = await sendInvite(alice, roomId, "r089c_ni_b");

    // R7 is inviter-only. Bob is the invitee; DELETE from him is 403
    // not_inviter (NOT the R5/R6 "not_invitee" error — the check is inverted).
    const res = await bob.agent.delete(`/api/v1/invitations/${invitationId}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_inviter");
  });

  test("REQ-089 R7 403 not_inviter when a third party tries to DELETE", async () => {
    const alice = await registerAgent(app, "r089c_ni3_a@example.com", "r089c_ni3_a");
    const bob = await registerAgent(app, "r089c_ni3_b@example.com", "r089c_ni3_b");
    const eve = await registerAgent(app, "r089c_ni3_e@example.com", "r089c_ni3_e");
    const roomId = await createPrivateRoom(alice, "Cancel NI3 R089");
    const invitationId = await sendInvite(alice, roomId, "r089c_ni3_b");

    const res = await eve.agent.delete(`/api/v1/invitations/${invitationId}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_inviter");
    void bob;
  });

  test("REQ-089 R7 happy path — 200 { cancelled: true }, status='declined' (reused terminal state)", async () => {
    const alice = await registerAgent(app, "r089c_ok_a@example.com", "r089c_ok_a");
    const bob = await registerAgent(app, "r089c_ok_b@example.com", "r089c_ok_b");
    const roomId = await createPrivateRoom(alice, "Cancel OK R089");
    const invitationId = await sendInvite(alice, roomId, "r089c_ok_b");

    const res = await alice.agent.delete(`/api/v1/invitations/${invitationId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: true });

    // §4 R7 reuses 'declined' for cancel — there is no 'cancelled' enum
    // value. respondedAt tracks the terminal transition for both decline
    // paths regardless of direction.
    const [row] = await getTestDb()
      .select({
        status: roomInvite.status,
        respondedAt: roomInvite.respondedAt,
      })
      .from(roomInvite)
      .where(eq(roomInvite.id, invitationId));
    expect(row?.status).toBe("declined");
    expect(row?.respondedAt).not.toBeNull();
    void bob;
  });

  test("REQ-089 R7 409 invitation_not_pending when already cancelled", async () => {
    const alice = await registerAgent(app, "r089c_2x_a@example.com", "r089c_2x_a");
    const bob = await registerAgent(app, "r089c_2x_b@example.com", "r089c_2x_b");
    const roomId = await createPrivateRoom(alice, "Cancel 2X R089");
    const invitationId = await sendInvite(alice, roomId, "r089c_2x_b");

    await alice.agent.delete(`/api/v1/invitations/${invitationId}`).expect(200);
    const second = await alice.agent.delete(
      `/api/v1/invitations/${invitationId}`,
    );
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("invitation_not_pending");
    void bob;
  });

  test("REQ-089 R7 409 invitation_not_pending when invitee already accepted", async () => {
    const alice = await registerAgent(app, "r089c_acc_a@example.com", "r089c_acc_a");
    const bob = await registerAgent(app, "r089c_acc_b@example.com", "r089c_acc_b");
    const roomId = await createPrivateRoom(alice, "Cancel ACC R089");
    const invitationId = await sendInvite(alice, roomId, "r089c_acc_b");

    await bob.agent.post(`/api/v1/invitations/${invitationId}/accept`).expect(200);
    const res = await alice.agent.delete(`/api/v1/invitations/${invitationId}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invitation_not_pending");
  });
});
