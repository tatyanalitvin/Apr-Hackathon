// R10 / REQ-057 block — POST /api/v1/friends/requests/:id/block
// Binding spec: docs/specs/s2-friendship.md §4 R10 + REQ-058 (silent).
//
// In a single transaction (caller must be toId of the row):
//   (a) specific :id row → status='rejected', respondedAt=now()
//   (b) any other pending friend_request in EITHER direction between the pair
//       → status='rejected' (mirrors R16 so outgoing-to-blocker survives)
//   (c) user_block(byId=caller, targetId=fromId) ON CONFLICT DO NOTHING
//   (d) any friendship row between the pair is DELETEd (defensive)
// 200 { status: 'blocked' }. No Socket.IO event (REQ-058 silent).

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
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

async function insertFriendship(userXId: string, userYId: string): Promise<string> {
  const id = randomUUID();
  const [a, b] = userXId < userYId ? [userXId, userYId] : [userYId, userXId];
  await getTestDb().insert(friendship).values({ id, userAId: a, userBId: b });
  return id;
}

describe("REQ-057 POST /api/v1/friends/requests/:id/block", () => {
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
      .post(`/api/v1/friends/requests/${randomUUID()}/block`);
    expect(res.status).toBe(401);
  });

  test("REQ-057 happy path: pending → rejected, user_block inserted, no friendship", async () => {
    const alice = await registerAgent(app, "r057bh-alice@example.com", "r057bh_alice");
    const bob = await registerAgent(app, "r057bh-bob@example.com", "r057bh_bob");
    const reqId = await insertFriendRequest(alice.userId, bob.userId, "pending");

    const res = await bob.agent.post(`/api/v1/friends/requests/${reqId}/block`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "blocked" });

    const [row] = await getTestDb()
      .select()
      .from(friendRequest)
      .where(eq(friendRequest.id, reqId));
    expect(row.status).toBe("rejected");
    expect(row.respondedAt).toBeInstanceOf(Date);

    const blocks = await getTestDb()
      .select()
      .from(userBlock)
      .where(and(eq(userBlock.byId, bob.userId), eq(userBlock.targetId, alice.userId)));
    expect(blocks).toHaveLength(1);

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
  });

  test("REQ-057 block rejects ALL pending requests in both directions between the pair", async () => {
    const alice = await registerAgent(app, "r057bm-alice@example.com", "r057bm_alice");
    const bob = await registerAgent(app, "r057bm-bob@example.com", "r057bm_bob");

    // The one bob will block (alice → bob).
    const incomingId = await insertFriendRequest(alice.userId, bob.userId, "pending");
    // The sneaky reverse pending: bob → alice, must also be rejected to avoid
    // an asymmetric survivor (spec R10 explicitly calls this out).
    const outgoingId = await insertFriendRequest(bob.userId, alice.userId, "pending");

    const res = await bob.agent.post(`/api/v1/friends/requests/${incomingId}/block`);
    expect(res.status).toBe(200);

    const [incomingRow] = await getTestDb()
      .select()
      .from(friendRequest)
      .where(eq(friendRequest.id, incomingId));
    expect(incomingRow.status).toBe("rejected");

    const [outgoingRow] = await getTestDb()
      .select()
      .from(friendRequest)
      .where(eq(friendRequest.id, outgoingId));
    expect(outgoingRow.status).toBe("rejected");
  });

  test("REQ-057 block tears down an existing friendship (defensive)", async () => {
    const alice = await registerAgent(app, "r057bf-alice@example.com", "r057bf_alice");
    const bob = await registerAgent(app, "r057bf-bob@example.com", "r057bf_bob");
    const reqId = await insertFriendRequest(alice.userId, bob.userId, "pending");
    await insertFriendship(alice.userId, bob.userId);

    const res = await bob.agent.post(`/api/v1/friends/requests/${reqId}/block`);
    expect(res.status).toBe(200);

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
  });

  test("REQ-057 caller is not the toId → 404 (no existence leak)", async () => {
    const alice = await registerAgent(app, "r057bx-alice@example.com", "r057bx_alice");
    const bob = await registerAgent(app, "r057bx-bob@example.com", "r057bx_bob");
    const eve = await registerAgent(app, "r057bx-eve@example.com", "r057bx_eve");
    const reqId = await insertFriendRequest(alice.userId, bob.userId, "pending");

    const res = await eve.agent.post(`/api/v1/friends/requests/${reqId}/block`);
    expect(res.status).toBe(404);

    const [row] = await getTestDb()
      .select()
      .from(friendRequest)
      .where(eq(friendRequest.id, reqId));
    expect(row.status).toBe("pending");

    const blocks = await getTestDb()
      .select()
      .from(userBlock)
      .where(eq(userBlock.byId, eve.userId));
    expect(blocks).toHaveLength(0);
  });

  test("REQ-057 non-existent request id → 404", async () => {
    const alice = await registerAgent(app, "r057bn-alice@example.com", "r057bn_alice");
    const res = await alice.agent.post(`/api/v1/friends/requests/${randomUUID()}/block`);
    expect(res.status).toBe(404);
  });

  test("REQ-057 block is idempotent on repeat — second call still 200, one user_block row", async () => {
    const alice = await registerAgent(app, "r057bi-alice@example.com", "r057bi_alice");
    const bob = await registerAgent(app, "r057bi-bob@example.com", "r057bi_bob");
    const reqId = await insertFriendRequest(alice.userId, bob.userId, "pending");

    const first = await bob.agent.post(`/api/v1/friends/requests/${reqId}/block`);
    expect(first.status).toBe(200);
    const second = await bob.agent.post(`/api/v1/friends/requests/${reqId}/block`);
    expect(second.status).toBe(200);

    const blocks = await getTestDb()
      .select()
      .from(userBlock)
      .where(and(eq(userBlock.byId, bob.userId), eq(userBlock.targetId, alice.userId)));
    expect(blocks).toHaveLength(1);
  });
});
