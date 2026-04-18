// R9 / REQ-057 decline — POST /api/v1/friends/requests/:id/decline
// Binding spec: docs/specs/s2-friendship.md §4 R9 + REQ-058 (silent).
//
// Effects on success:
//   1. friend_request row → status='rejected', respondedAt=now()
//   2. NO friendship row inserted
//   3. NO user_block row inserted
//   4. 200 { status: 'rejected' }
// Auth: caller must be the `toId` of the request. No Socket.IO event on any
// outcome (REQ-058 — decline is silent).
//
// Terminal states mirror R8: already-accepted → 409 already_friends (decline
// can't reverse acceptance); already-rejected → 200 idempotent (decline is
// the rejected state; calling twice is a no-op).

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { friendRequest, friendship, user, userBlock } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

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

async function insertFriendRequest(
  fromId: string,
  toId: string,
  status: "pending" | "accepted" | "rejected" = "pending",
): Promise<string> {
  const id = randomUUID();
  await getTestDb().insert(friendRequest).values({
    id,
    fromId,
    toId,
    status,
    message: null,
  });
  return id;
}

describe("REQ-057 POST /api/v1/friends/requests/:id/decline", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-057 no cookie → 401 unauthorized", async () => {
    const res = await request(app.server)
      .post(`/api/v1/friends/requests/${randomUUID()}/decline`);
    expect(res.status).toBe(401);
  });

  test("REQ-057 happy path: pending → rejected, no friendship, no block", async () => {
    const alice = await registerAgent(app, "r057dh-alice@example.com", "r057dh_alice");
    const bob = await registerAgent(app, "r057dh-bob@example.com", "r057dh_bob");
    const reqId = await insertFriendRequest(alice.userId, bob.userId, "pending");

    const res = await bob.agent.post(`/api/v1/friends/requests/${reqId}/decline`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "rejected" });

    const [row] = await getTestDb()
      .select()
      .from(friendRequest)
      .where(eq(friendRequest.id, reqId));
    expect(row.status).toBe("rejected");
    expect(row.respondedAt).toBeInstanceOf(Date);

    const friendships = await getTestDb()
      .select()
      .from(friendship)
      .where(
        or(
          eq(friendship.userAId, alice.userId),
          eq(friendship.userBId, alice.userId),
        ),
      );
    expect(friendships).toHaveLength(0);

    const blocks = await getTestDb()
      .select()
      .from(userBlock)
      .where(
        or(
          eq(userBlock.byId, alice.userId),
          eq(userBlock.byId, bob.userId),
        ),
      );
    expect(blocks).toHaveLength(0);
  });

  test("REQ-057 caller is not the toId → 404 (no existence leak)", async () => {
    const alice = await registerAgent(app, "r057dx-alice@example.com", "r057dx_alice");
    const bob = await registerAgent(app, "r057dx-bob@example.com", "r057dx_bob");
    const eve = await registerAgent(app, "r057dx-eve@example.com", "r057dx_eve");
    const reqId = await insertFriendRequest(alice.userId, bob.userId, "pending");

    const res = await eve.agent.post(`/api/v1/friends/requests/${reqId}/decline`);
    expect(res.status).toBe(404);

    const [row] = await getTestDb()
      .select()
      .from(friendRequest)
      .where(eq(friendRequest.id, reqId));
    expect(row.status).toBe("pending");
  });

  test("REQ-057 non-existent request id → 404", async () => {
    const alice = await registerAgent(app, "r057dn-alice@example.com", "r057dn_alice");
    const res = await alice.agent.post(`/api/v1/friends/requests/${randomUUID()}/decline`);
    expect(res.status).toBe(404);
  });

  test("REQ-057 already-accepted → 409 already_friends (decline can't reverse acceptance)", async () => {
    const alice = await registerAgent(app, "r057da-alice@example.com", "r057da_alice");
    const bob = await registerAgent(app, "r057da-bob@example.com", "r057da_bob");
    const reqId = await insertFriendRequest(alice.userId, bob.userId, "accepted");

    const res = await bob.agent.post(`/api/v1/friends/requests/${reqId}/decline`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "already_friends" });
  });

  test("REQ-057 already-rejected → 200 idempotent (same status, no row change)", async () => {
    const alice = await registerAgent(app, "r057dr-alice@example.com", "r057dr_alice");
    const bob = await registerAgent(app, "r057dr-bob@example.com", "r057dr_bob");
    const reqId = await insertFriendRequest(alice.userId, bob.userId, "rejected");

    const res = await bob.agent.post(`/api/v1/friends/requests/${reqId}/decline`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "rejected" });
  });
});
