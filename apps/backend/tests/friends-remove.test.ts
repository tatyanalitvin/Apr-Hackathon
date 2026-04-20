import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// R12 / REQ-059 — DELETE /api/v1/friends/:userId
// Binding spec: docs/specs/s2-friendship.md §4 R12.
//
// Caller can be either side of the friendship (userAId or userBId — the row
// is normalized, but the caller doesn't know the sort). DELETEs the single
// friendship row for the normalized pair and returns 204.
// Idempotent: 204 even if no friendship existed (prevents enumeration by
// checking which friend pairings are "real").
// No Socket.IO event on this path (REQ-059 is silent; the DM freeze
// side-effect is a read-time predicate in s2-dms.md).

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
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

async function insertFriendship(userXId: string, userYId: string): Promise<string> {
  const id = randomUUID();
  const [a, b] = userXId < userYId ? [userXId, userYId] : [userYId, userXId];
  await getTestDb().insert(friendship).values({ id, userAId: a, userBId: b });
  return id;
}

describe("REQ-059 DELETE /api/v1/friends/:userId", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-059 no cookie → 401 unauthorized", async () => {
    const res = await request(app.server)
      .delete(`/api/v1/friends/${randomUUID()}`);
    expect(res.status).toBe(401);
  });

  test("REQ-059 happy path: caller is userAId side → friendship row deleted, 204", async () => {
    const alice = await registerAgent(app, "r059a-alice@example.com", "r059a_alice");
    const bob = await registerAgent(app, "r059a-bob@example.com", "r059a_bob");
    await insertFriendship(alice.userId, bob.userId);

    const res = await alice.agent.delete(`/api/v1/friends/${bob.userId}`);
    expect(res.status).toBe(204);

    const rows = await getTestDb()
      .select()
      .from(friendship)
      .where(
        or(
          eq(friendship.userAId, alice.userId),
          eq(friendship.userBId, alice.userId),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  test("REQ-059 happy path: caller is userBId side — reverse direction also works", async () => {
    const alice = await registerAgent(app, "r059b-alice@example.com", "r059b_alice");
    const bob = await registerAgent(app, "r059b-bob@example.com", "r059b_bob");
    await insertFriendship(alice.userId, bob.userId);

    const res = await bob.agent.delete(`/api/v1/friends/${alice.userId}`);
    expect(res.status).toBe(204);

    const rows = await getTestDb()
      .select()
      .from(friendship)
      .where(
        or(
          eq(friendship.userAId, bob.userId),
          eq(friendship.userBId, bob.userId),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  test("REQ-059 idempotent: no friendship exists → 204", async () => {
    const alice = await registerAgent(app, "r059i-alice@example.com", "r059i_alice");
    const bob = await registerAgent(app, "r059i-bob@example.com", "r059i_bob");

    const res = await alice.agent.delete(`/api/v1/friends/${bob.userId}`);
    expect(res.status).toBe(204);
  });

  test("REQ-059 does not delete friendships with third parties", async () => {
    const alice = await registerAgent(app, "r059c-alice@example.com", "r059c_alice");
    const bob = await registerAgent(app, "r059c-bob@example.com", "r059c_bob");
    const carol = await registerAgent(app, "r059c-carol@example.com", "r059c_carol");
    await insertFriendship(alice.userId, bob.userId);
    await insertFriendship(alice.userId, carol.userId);

    const res = await alice.agent.delete(`/api/v1/friends/${bob.userId}`);
    expect(res.status).toBe(204);

    const rows = await getTestDb().select().from(friendship);
    expect(rows).toHaveLength(1);
    // Remaining row is alice–carol.
    const remaining = rows[0];
    const pair = new Set([remaining.userAId, remaining.userBId]);
    expect(pair.has(alice.userId)).toBe(true);
    expect(pair.has(carol.userId)).toBe(true);
  });
});
