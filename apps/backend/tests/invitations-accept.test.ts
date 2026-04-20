import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-089 R5 — POST /api/v1/invitations/:id/accept.
// Binding: docs/specs/s2-invitations.md §4 R5.
//
// MUST semantics (spec §4 R5): UPDATE invite → INSERT roomMember is a single
// atomic transaction. If the INSERT fails for any reason, the UPDATE MUST
// roll back (no half-state: pending-in-spirit but status='accepted').
//
// The forced-rollback test in this file installs a BEFORE INSERT trigger on
// `room_member` that raises an exception only for a sentinel (roomId,userId),
// then calls accept and asserts the invite row is still 'pending' after the
// handler returns — proving the transaction wrapped both statements and that
// the middle failure did not leak a half-commit. This is the MUST that the
// happy-path test in invitations-socket.test.ts cannot cover: it only proves
// the two-step effect, not the rollback.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { roomInvite, roomMember, user } from "@ai-herders/shared/schema";

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

describe("REQ-089 POST /invitations/:id/accept — R5 contract + atomicity", () => {
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

  test("REQ-089 R5 401 when unauthenticated", async () => {
    const anon = request.agent(app.server);
    const res = await anon.post("/api/v1/invitations/some-id/accept");
    expect(res.status).toBe(401);
  });

  test("REQ-089 R5 404 invitation_not_found when id does not exist", async () => {
    const alice = await registerAgent(app, "r089a_nf@example.com", "r089a_nf");
    const res = await alice.agent.post(
      "/api/v1/invitations/00000000-0000-0000-0000-000000000000/accept",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("invitation_not_found");
  });

  test("REQ-089 R5 403 not_invitee when caller is NOT the invitee (e.g. the inviter)", async () => {
    const alice = await registerAgent(app, "r089a_ni_a@example.com", "r089a_ni_a");
    const bob = await registerAgent(app, "r089a_ni_b@example.com", "r089a_ni_b");
    const roomId = await createPrivateRoom(alice, "Accept NI R089");
    const invitationId = await sendInvite(alice, roomId, "r089a_ni_b");

    // Inviter (alice) tries to accept her own outgoing invite → 403.
    const res = await alice.agent.post(
      `/api/v1/invitations/${invitationId}/accept`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_invitee");
    void bob;
  });

  test("REQ-089 R5 403 not_invitee when a third party tries to accept", async () => {
    const alice = await registerAgent(app, "r089a_ni3_a@example.com", "r089a_ni3_a");
    const bob = await registerAgent(app, "r089a_ni3_b@example.com", "r089a_ni3_b");
    const eve = await registerAgent(app, "r089a_ni3_e@example.com", "r089a_ni3_e");
    const roomId = await createPrivateRoom(alice, "Accept NI3 R089");
    const invitationId = await sendInvite(alice, roomId, "r089a_ni3_b");

    const res = await eve.agent.post(
      `/api/v1/invitations/${invitationId}/accept`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_invitee");
    void bob;
  });

  test("REQ-089 R5 409 invitation_not_pending when already accepted", async () => {
    const alice = await registerAgent(app, "r089a_2x_a@example.com", "r089a_2x_a");
    const bob = await registerAgent(app, "r089a_2x_b@example.com", "r089a_2x_b");
    const roomId = await createPrivateRoom(alice, "Accept 2X R089");
    const invitationId = await sendInvite(alice, roomId, "r089a_2x_b");

    // First accept succeeds.
    await bob.agent.post(`/api/v1/invitations/${invitationId}/accept`).expect(200);

    // Second accept on the same row must 409 — status is already 'accepted'.
    const second = await bob.agent.post(
      `/api/v1/invitations/${invitationId}/accept`,
    );
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("invitation_not_pending");
  });

  test("REQ-089 R5 409 invitation_not_pending when expired", async () => {
    const alice = await registerAgent(app, "r089a_exp_a@example.com", "r089a_exp_a");
    const bob = await registerAgent(app, "r089a_exp_b@example.com", "r089a_exp_b");
    const roomId = await createPrivateRoom(alice, "Accept EXP R089");
    const invitationId = await sendInvite(alice, roomId, "r089a_exp_b");

    // Age the invite out of the live window; status stays 'pending' (the
    // REQ-157 GC sweep would flip it to 'expired' later). R5 MUST 409 here
    // even though status is still literally 'pending'.
    await getTestPool().query(
      `UPDATE room_invite SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [invitationId],
    );

    const res = await bob.agent.post(
      `/api/v1/invitations/${invitationId}/accept`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invitation_not_pending");
  });

  test("REQ-089 R5 happy path — 200, invite='accepted', roomMember row exists", async () => {
    const alice = await registerAgent(app, "r089a_ok_a@example.com", "r089a_ok_a");
    const bob = await registerAgent(app, "r089a_ok_b@example.com", "r089a_ok_b");
    const roomId = await createPrivateRoom(alice, "Accept OK R089");
    const invitationId = await sendInvite(alice, roomId, "r089a_ok_b");

    const res = await bob.agent.post(
      `/api/v1/invitations/${invitationId}/accept`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ joined: true, roomId });

    const [invRow] = await getTestDb()
      .select({ status: roomInvite.status, respondedAt: roomInvite.respondedAt })
      .from(roomInvite)
      .where(eq(roomInvite.id, invitationId));
    expect(invRow?.status).toBe("accepted");
    expect(invRow?.respondedAt).not.toBeNull();

    const [memberRow] = await getTestDb()
      .select({ role: roomMember.role })
      .from(roomMember)
      .where(
        and(eq(roomMember.roomId, roomId), eq(roomMember.userId, bob.userId)),
      );
    expect(memberRow?.role).toBe("member");
  });

  test("REQ-089 R5 atomicity — INSERT failure rolls back the UPDATE (invite stays 'pending')", async () => {
    const alice = await registerAgent(app, "r089a_atom_a@example.com", "r089a_atom_a");
    const bob = await registerAgent(app, "r089a_atom_b@example.com", "r089a_atom_b");
    const roomId = await createPrivateRoom(alice, "Accept ATOM R089");
    const invitationId = await sendInvite(alice, roomId, "r089a_atom_b");

    // Install a BEFORE INSERT trigger that blocks the specific (roomId,userId)
    // tuple this test accepts. Scoping the WHEN clause to these exact values
    // keeps other tests in the same beforeAll session unaffected if any run
    // before us — and we always DROP in the finally block so the installer is
    // hermetic even on assertion failure.
    const triggerName = "test_r5_atom_block";
    const fnName = "test_r5_atom_block_fn";
    const pool = getTestPool();
    await pool.query(`
      CREATE OR REPLACE FUNCTION ${fnName}() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'r5_atomicity_simulated_failure';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query(`
      DROP TRIGGER IF EXISTS ${triggerName} ON room_member;
      CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON room_member
        FOR EACH ROW
        WHEN (NEW.user_id = '${bob.userId}' AND NEW.room_id = '${roomId}')
        EXECUTE FUNCTION ${fnName}();
    `);

    try {
      // The handler's transaction should catch the trigger's RAISE, ROLLBACK,
      // and the default Fastify error flow returns 500. We do NOT assert a
      // specific status shape — the atomicity contract is about DB state, not
      // HTTP body. What matters: after the handler returns (however it
      // returns), invite.status === 'pending' and no roomMember row exists.
      const res = await bob.agent.post(
        `/api/v1/invitations/${invitationId}/accept`,
      );
      expect(res.status).toBeGreaterThanOrEqual(500);

      const [invRow] = await getTestDb()
        .select({
          status: roomInvite.status,
          respondedAt: roomInvite.respondedAt,
        })
        .from(roomInvite)
        .where(eq(roomInvite.id, invitationId));
      expect(invRow?.status).toBe("pending");
      expect(invRow?.respondedAt).toBeNull();

      const members = await getTestDb()
        .select({ id: roomMember.id })
        .from(roomMember)
        .where(
          and(eq(roomMember.roomId, roomId), eq(roomMember.userId, bob.userId)),
        );
      expect(members).toHaveLength(0);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON room_member`);
      await pool.query(`DROP FUNCTION IF EXISTS ${fnName}()`);
    }
  });

  test("REQ-089 R5 atomicity — after trigger removed, retry succeeds (invite still 'pending')", async () => {
    const alice = await registerAgent(app, "r089a_retry_a@example.com", "r089a_retry_a");
    const bob = await registerAgent(app, "r089a_retry_b@example.com", "r089a_retry_b");
    const roomId = await createPrivateRoom(alice, "Accept RETRY R089");
    const invitationId = await sendInvite(alice, roomId, "r089a_retry_b");

    const triggerName = "test_r5_retry_block";
    const fnName = "test_r5_retry_block_fn";
    const pool = getTestPool();
    await pool.query(`
      CREATE OR REPLACE FUNCTION ${fnName}() RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'r5_retry_simulated_failure';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query(`
      DROP TRIGGER IF EXISTS ${triggerName} ON room_member;
      CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON room_member
        FOR EACH ROW
        WHEN (NEW.user_id = '${bob.userId}' AND NEW.room_id = '${roomId}')
        EXECUTE FUNCTION ${fnName}();
    `);

    // First attempt fails.
    const failed = await bob.agent.post(
      `/api/v1/invitations/${invitationId}/accept`,
    );
    expect(failed.status).toBeGreaterThanOrEqual(500);

    // Trigger removed — prove the invite is still pending (not 'accepted').
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON room_member`);
    await pool.query(`DROP FUNCTION IF EXISTS ${fnName}()`);

    // Retry now succeeds and the user becomes a member. This is the forward
    // path that matters for the user-visible contract: a rolled-back accept
    // must be retryable without any cleanup.
    const retry = await bob.agent.post(
      `/api/v1/invitations/${invitationId}/accept`,
    );
    expect(retry.status).toBe(200);

    const [invRow] = await getTestDb()
      .select({ status: roomInvite.status })
      .from(roomInvite)
      .where(eq(roomInvite.id, invitationId));
    expect(invRow?.status).toBe("accepted");

    const [memberRow] = await getTestDb()
      .select({ id: roomMember.id })
      .from(roomMember)
      .where(
        and(eq(roomMember.roomId, roomId), eq(roomMember.userId, bob.userId)),
      );
    expect(memberRow).toBeDefined();
  });
});
