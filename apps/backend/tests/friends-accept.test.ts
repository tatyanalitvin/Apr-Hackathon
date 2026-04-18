// R8 / REQ-057 — POST /api/v1/friends/requests/:id/accept
// Binding spec: docs/specs/s2-friendship.md §4 R8.
//
// Effects on success:
//   1. friend_request row → status='accepted', respondedAt=now()
//   2. friendship row inserted with normalized (userAId < userBId)
//   3. 200 { status: 'accepted', friendshipId }
// Auth: caller must be the `toId` of the request. Hiding existence of a row
// targeted at someone else → 404 not_found (no leak).
// Terminal states: accepted → 409 already_friends; rejected → 409 request_declined.
// Socket emit (R11/REQ-058) is covered separately in friends-socket-accept.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { friendRequest, friendship, user } from "@ai-herders/shared/schema";

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

describe("REQ-057 POST /api/v1/friends/requests/:id/accept", () => {
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
      .post(`/api/v1/friends/requests/${randomUUID()}/accept`);
    expect(res.status).toBe(401);
  });

  test("REQ-057 happy path: pending → accepted, friendship inserted, friendshipId returned", async () => {
    const alice = await registerAgent(app, "r057h-alice@example.com", "r057h_alice");
    const bob = await registerAgent(app, "r057h-bob@example.com", "r057h_bob");
    const reqId = await insertFriendRequest(alice.userId, bob.userId, "pending");

    const res = await bob.agent.post(`/api/v1/friends/requests/${reqId}/accept`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "accepted" });
    expect(typeof res.body.friendshipId).toBe("string");
    expect(res.body.friendshipId.length).toBeGreaterThan(0);

    const [reqRow] = await getTestDb()
      .select()
      .from(friendRequest)
      .where(eq(friendRequest.id, reqId));
    expect(reqRow.status).toBe("accepted");
    expect(reqRow.respondedAt).toBeInstanceOf(Date);

    // Friendship row with normalized user pair (userAId < userBId).
    const [low, high] =
      alice.userId < bob.userId
        ? [alice.userId, bob.userId]
        : [bob.userId, alice.userId];
    const [fsRow] = await getTestDb()
      .select()
      .from(friendship)
      .where(and(eq(friendship.userAId, low), eq(friendship.userBId, high)));
    expect(fsRow).toBeDefined();
    expect(fsRow.id).toBe(res.body.friendshipId);
  });

  test("REQ-057 caller is not the toId → 404 (no existence leak)", async () => {
    const alice = await registerAgent(app, "r057x-alice@example.com", "r057x_alice");
    const bob = await registerAgent(app, "r057x-bob@example.com", "r057x_bob");
    const eve = await registerAgent(app, "r057x-eve@example.com", "r057x_eve");
    const reqId = await insertFriendRequest(alice.userId, bob.userId, "pending");

    const res = await eve.agent.post(`/api/v1/friends/requests/${reqId}/accept`);
    expect(res.status).toBe(404);

    // Row untouched.
    const [reqRow] = await getTestDb()
      .select()
      .from(friendRequest)
      .where(eq(friendRequest.id, reqId));
    expect(reqRow.status).toBe("pending");

    // No friendship row exists for any pair involving eve.
    const fs = await getTestDb()
      .select()
      .from(friendship)
      .where(
        or(
          eq(friendship.userAId, eve.userId),
          eq(friendship.userBId, eve.userId),
        ),
      );
    expect(fs).toHaveLength(0);
  });

  test("REQ-057 non-existent request id → 404", async () => {
    const alice = await registerAgent(app, "r057n-alice@example.com", "r057n_alice");
    const res = await alice.agent.post(`/api/v1/friends/requests/${randomUUID()}/accept`);
    expect(res.status).toBe(404);
  });

  test("REQ-057 already-accepted → 409 already_friends", async () => {
    const alice = await registerAgent(app, "r057a-alice@example.com", "r057a_alice");
    const bob = await registerAgent(app, "r057a-bob@example.com", "r057a_bob");
    const reqId = await insertFriendRequest(alice.userId, bob.userId, "accepted");

    const res = await bob.agent.post(`/api/v1/friends/requests/${reqId}/accept`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "already_friends" });
  });

  test("REQ-057 already-rejected → 409 request_declined (Q5a terminal)", async () => {
    const alice = await registerAgent(app, "r057r-alice@example.com", "r057r_alice");
    const bob = await registerAgent(app, "r057r-bob@example.com", "r057r_bob");
    const reqId = await insertFriendRequest(alice.userId, bob.userId, "rejected");

    const res = await bob.agent.post(`/api/v1/friends/requests/${reqId}/accept`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "request_declined" });
  });
});
