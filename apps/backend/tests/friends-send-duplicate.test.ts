// R6 / REQ-055 — duplicate friend-request semantics.
// Binding spec: docs/specs/s2-friendship.md §4 R6 + §8 Q5 (decision: a).
//
// Three collision branches on the unique index (fromId, toId):
//   - pending   → UPDATE message + createdAt, return 200 with same id
//   - accepted  → 409 already_friends
//   - rejected  → 409 request_declined (terminal per Q5a)

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { friendRequest, user } from "@ai-herders/shared/schema";

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
  status: "pending" | "accepted" | "rejected",
  overrides: { message?: string; createdAt?: Date } = {},
): Promise<string> {
  const id = randomUUID();
  await getTestDb().insert(friendRequest).values({
    id,
    fromId,
    toId,
    status,
    message: overrides.message ?? null,
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
  });
  return id;
}

describe("REQ-055 POST /api/v1/friends/requests duplicate branches", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-055 pending duplicate → 200 with same id, message + createdAt updated", async () => {
    const alice = await registerAgent(app, "r055p-alice@example.com", "r055p_alice");
    const bob = await registerAgent(app, "r055p-bob@example.com", "r055p_bob");

    const originalCreatedAt = new Date(Date.now() - 60 * 60_000);
    const originalId = await insertFriendRequest(alice.userId, bob.userId, "pending", {
      message: "first note",
      createdAt: originalCreatedAt,
    });

    const res = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "r055p_bob", message: "second note" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: originalId, status: "pending" });

    const [row] = await getTestDb()
      .select()
      .from(friendRequest)
      .where(eq(friendRequest.id, originalId));
    expect(row.message).toBe("second note");
    expect(row.createdAt.getTime()).toBeGreaterThan(originalCreatedAt.getTime());
    expect(row.status).toBe("pending");

    // Exactly one row for the (from, to) pair — no duplicate inserted.
    const allRows = await getTestDb()
      .select()
      .from(friendRequest)
      .where(
        and(eq(friendRequest.fromId, alice.userId), eq(friendRequest.toId, bob.userId)),
      );
    expect(allRows).toHaveLength(1);
  });

  test("REQ-055 accepted duplicate → 409 already_friends", async () => {
    const alice = await registerAgent(app, "r055a-alice@example.com", "r055a_alice");
    const bob = await registerAgent(app, "r055a-bob@example.com", "r055a_bob");
    await insertFriendRequest(alice.userId, bob.userId, "accepted");

    const res = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "r055a_bob" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "already_friends" });
  });

  test("REQ-055 rejected duplicate → 409 request_declined (Q5a terminal)", async () => {
    const alice = await registerAgent(app, "r055r-alice@example.com", "r055r_alice");
    const bob = await registerAgent(app, "r055r-bob@example.com", "r055r_bob");
    await insertFriendRequest(alice.userId, bob.userId, "rejected");

    const res = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "r055r_bob", message: "please reconsider" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "request_declined" });

    // Status must remain 'rejected' — decline is terminal.
    const [row] = await getTestDb()
      .select()
      .from(friendRequest)
      .where(
        and(eq(friendRequest.fromId, alice.userId), eq(friendRequest.toId, bob.userId)),
      );
    expect(row.status).toBe("rejected");
  });
});
