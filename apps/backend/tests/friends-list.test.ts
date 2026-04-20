import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// R1 / REQ-050 — GET /api/v1/friends returns the caller's accepted friends.
// Binding spec: docs/specs/s2-friendship.md §4 R1.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { friendship, user } from "@ai-herders/shared/schema";

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
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

// Normalized friendship insert — user_a_id < user_b_id (CHECK in migration 0003).
async function insertFriendship(
  userOne: string,
  userTwo: string,
  friendedAt?: Date,
): Promise<string> {
  const [a, b] = userOne < userTwo ? [userOne, userTwo] : [userTwo, userOne];
  const id = randomUUID();
  await getTestDb().insert(friendship).values({
    id,
    userAId: a,
    userBId: b,
    ...(friendedAt ? { createdAt: friendedAt } : {}),
  });
  return id;
}

describe("REQ-050 GET /api/v1/friends returns accepted friends", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-050 no cookie → 401 unauthorized", async () => {
    const res = await request(app.server).get("/api/v1/friends");
    expect(res.status).toBe(401);
  });

  test("REQ-050 authed with zero friends → 200 { friends: [] }", async () => {
    const alice = await registerAgent(app, "r050-lonely@example.com", "r050_lonely");
    void alice.userId;

    const res = await alice.agent.get("/api/v1/friends");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ friends: [] });
  });

  test("REQ-050 friendship symmetry — each side sees the other", async () => {
    const alice = await registerAgent(app, "r050-alice@example.com", "r050_alice");
    const bob = await registerAgent(app, "r050-bob@example.com", "r050_bob");
    await insertFriendship(alice.userId, bob.userId);

    const aliceRes = await alice.agent.get("/api/v1/friends");
    expect(aliceRes.status).toBe(200);
    expect(aliceRes.body.friends).toHaveLength(1);
    expect(aliceRes.body.friends[0]).toMatchObject({
      userId: bob.userId,
      username: "r050_bob",
      name: "r050_bob",
    });
    expect(typeof aliceRes.body.friends[0].friendedAt).toBe("string");

    const bobRes = await bob.agent.get("/api/v1/friends");
    expect(bobRes.status).toBe(200);
    expect(bobRes.body.friends).toHaveLength(1);
    expect(bobRes.body.friends[0]).toMatchObject({
      userId: alice.userId,
      username: "r050_alice",
      name: "r050_alice",
    });
  });

  test("REQ-050 friends ordered by friendedAt DESC (newest first)", async () => {
    const alice = await registerAgent(app, "r050-sorter@example.com", "r050_sorter");
    const bob = await registerAgent(app, "r050-old@example.com", "r050_old");
    const carol = await registerAgent(app, "r050-new@example.com", "r050_new");

    const olderDate = new Date(Date.now() - 10 * 60_000);
    const newerDate = new Date();
    await insertFriendship(alice.userId, bob.userId, olderDate);
    await insertFriendship(alice.userId, carol.userId, newerDate);

    const res = await alice.agent.get("/api/v1/friends");
    expect(res.status).toBe(200);
    expect(res.body.friends).toHaveLength(2);
    // Newest friendship first — carol before bob.
    expect(res.body.friends[0].username).toBe("r050_new");
    expect(res.body.friends[1].username).toBe("r050_old");
  });
});
