// R16 / REQ-073 — POST /api/v1/users/:id/block
// Binding spec: docs/specs/s2-friendship.md §4 R16.
//
// Single transaction (caller=byId, target=:id):
//   1. INSERT user_block ON CONFLICT DO NOTHING — idempotent
//   2. DELETE any friendship row between the pair (effect 1 of REQ-073)
//   3. UPDATE any pending friend_request rows in either direction between
//      the pair to status='rejected' (defensive: closes a race window
//      where the target could send a request concurrently with the block)
// 204 on success. 400 if byId === targetId (self-block).
//
// DM freeze (REQ-073 effect 2) is a READ-time predicate in s2-dms.md; this
// handler only owns the user_block row + friendship/request teardown. The
// presence-under-ban side (REQ-105) is S2 presence spec and reads the same
// user_block row.

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

async function insertFriendship(userXId: string, userYId: string): Promise<string> {
  const id = randomUUID();
  const [a, b] = userXId < userYId ? [userXId, userYId] : [userYId, userXId];
  await getTestDb().insert(friendship).values({ id, userAId: a, userBId: b });
  return id;
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

describe("REQ-073 POST /api/v1/users/:id/block", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-073 no cookie → 401 unauthorized", async () => {
    const res = await request(app.server)
      .post(`/api/v1/users/${randomUUID()}/block`);
    expect(res.status).toBe(401);
  });

  test("REQ-073 happy path: user_block inserted, 204", async () => {
    const alice = await registerAgent(app, "r073h-alice@example.com", "r073h_alice");
    const bob = await registerAgent(app, "r073h-bob@example.com", "r073h_bob");

    const res = await alice.agent.post(`/api/v1/users/${bob.userId}/block`);
    expect(res.status).toBe(204);

    const blocks = await getTestDb()
      .select()
      .from(userBlock)
      .where(and(eq(userBlock.byId, alice.userId), eq(userBlock.targetId, bob.userId)));
    expect(blocks).toHaveLength(1);
  });

  test("REQ-073 tears down existing friendship (effect 1)", async () => {
    const alice = await registerAgent(app, "r073f-alice@example.com", "r073f_alice");
    const bob = await registerAgent(app, "r073f-bob@example.com", "r073f_bob");
    await insertFriendship(alice.userId, bob.userId);

    const res = await alice.agent.post(`/api/v1/users/${bob.userId}/block`);
    expect(res.status).toBe(204);

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

  test("REQ-073 rejects pending requests in both directions", async () => {
    const alice = await registerAgent(app, "r073r-alice@example.com", "r073r_alice");
    const bob = await registerAgent(app, "r073r-bob@example.com", "r073r_bob");
    const outgoingId = await insertFriendRequest(alice.userId, bob.userId, "pending");
    const incomingId = await insertFriendRequest(bob.userId, alice.userId, "pending");

    const res = await alice.agent.post(`/api/v1/users/${bob.userId}/block`);
    expect(res.status).toBe(204);

    const [outgoingRow] = await getTestDb()
      .select()
      .from(friendRequest)
      .where(eq(friendRequest.id, outgoingId));
    expect(outgoingRow.status).toBe("rejected");

    const [incomingRow] = await getTestDb()
      .select()
      .from(friendRequest)
      .where(eq(friendRequest.id, incomingId));
    expect(incomingRow.status).toBe("rejected");
  });

  test("REQ-073 self-block → 400", async () => {
    const alice = await registerAgent(app, "r073s-alice@example.com", "r073s_alice");
    const res = await alice.agent.post(`/api/v1/users/${alice.userId}/block`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "self_block" });

    const blocks = await getTestDb()
      .select()
      .from(userBlock)
      .where(eq(userBlock.byId, alice.userId));
    expect(blocks).toHaveLength(0);
  });

  test("REQ-073 idempotent: repeat block → 204, single user_block row", async () => {
    const alice = await registerAgent(app, "r073i-alice@example.com", "r073i_alice");
    const bob = await registerAgent(app, "r073i-bob@example.com", "r073i_bob");

    const first = await alice.agent.post(`/api/v1/users/${bob.userId}/block`);
    expect(first.status).toBe(204);
    const second = await alice.agent.post(`/api/v1/users/${bob.userId}/block`);
    expect(second.status).toBe(204);

    const blocks = await getTestDb()
      .select()
      .from(userBlock)
      .where(and(eq(userBlock.byId, alice.userId), eq(userBlock.targetId, bob.userId)));
    expect(blocks).toHaveLength(1);
  });

  test("REQ-073 third-party state untouched (alice blocking bob does not affect alice-carol)", async () => {
    const alice = await registerAgent(app, "r073t-alice@example.com", "r073t_alice");
    const bob = await registerAgent(app, "r073t-bob@example.com", "r073t_bob");
    const carol = await registerAgent(app, "r073t-carol@example.com", "r073t_carol");
    await insertFriendship(alice.userId, carol.userId);
    await insertFriendship(alice.userId, bob.userId);
    const aliceCarolPending = await insertFriendRequest(alice.userId, carol.userId, "pending");

    const res = await alice.agent.post(`/api/v1/users/${bob.userId}/block`);
    expect(res.status).toBe(204);

    // alice–carol friendship survives.
    const carolFriendship = await getTestDb()
      .select()
      .from(friendship)
      .where(
        or(
          and(eq(friendship.userAId, alice.userId), eq(friendship.userBId, carol.userId)),
          and(eq(friendship.userAId, carol.userId), eq(friendship.userBId, alice.userId)),
        ),
      );
    expect(carolFriendship).toHaveLength(1);

    // alice → carol pending row untouched.
    const [row] = await getTestDb()
      .select()
      .from(friendRequest)
      .where(eq(friendRequest.id, aliceCarolPending));
    expect(row.status).toBe("pending");
  });
});
