// R18 / REQ-074 — DELETE /api/v1/users/:id/ban
// Binding spec: docs/specs/s2-friendship.md §4 R18.
//
// Removes the user_block row WHERE byId=caller AND targetId=:id.
// Idempotent (204 even if no row existed).
// Does NOT restore friendship — REQ-074 explicit. A re-friend requires a
// fresh request. The DM auto-unfreeze (REQ-066) is a read-time predicate
// in s2-dms.md that checks friendship AND no active user_block.
// One-way: unblocking bob does not remove a parallel bob→alice block.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { friendship, user, userBlock } from "@ai-herders/shared/schema";

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

async function insertBlock(byId: string, targetId: string): Promise<void> {
  await getTestDb().insert(userBlock).values({
    id: randomUUID(),
    byId,
    targetId,
  });
}

describe("REQ-074 DELETE /api/v1/users/:id/ban", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-074 no cookie → 401 unauthorized", async () => {
    const res = await request(app.server)
      .delete(`/api/v1/users/${randomUUID()}/ban`);
    expect(res.status).toBe(401);
  });

  test("REQ-074 happy path: removes user_block row, 204", async () => {
    const alice = await registerAgent(app, "r074h-alice@example.com", "r074h_alice");
    const bob = await registerAgent(app, "r074h-bob@example.com", "r074h_bob");
    await insertBlock(alice.userId, bob.userId);

    const res = await alice.agent.delete(`/api/v1/users/${bob.userId}/ban`);
    expect(res.status).toBe(204);

    const blocks = await getTestDb()
      .select()
      .from(userBlock)
      .where(and(eq(userBlock.byId, alice.userId), eq(userBlock.targetId, bob.userId)));
    expect(blocks).toHaveLength(0);
  });

  test("REQ-074 idempotent: no block exists → 204", async () => {
    const alice = await registerAgent(app, "r074i-alice@example.com", "r074i_alice");
    const bob = await registerAgent(app, "r074i-bob@example.com", "r074i_bob");

    const res = await alice.agent.delete(`/api/v1/users/${bob.userId}/ban`);
    expect(res.status).toBe(204);
  });

  test("REQ-074 does NOT restore friendship (explicit in REQ-074)", async () => {
    const alice = await registerAgent(app, "r074f-alice@example.com", "r074f_alice");
    const bob = await registerAgent(app, "r074f-bob@example.com", "r074f_bob");
    // Blocked state WITHOUT a pre-existing friendship (REQ-073 would have
    // torn it down on block). Now alice unbans bob — no friendship appears.
    await insertBlock(alice.userId, bob.userId);

    const res = await alice.agent.delete(`/api/v1/users/${bob.userId}/ban`);
    expect(res.status).toBe(204);

    const friendships = await getTestDb().select().from(friendship);
    expect(friendships).toHaveLength(0);
  });

  test("REQ-074 one-way: alice unblocking bob does not remove bob's block on alice", async () => {
    const alice = await registerAgent(app, "r074o-alice@example.com", "r074o_alice");
    const bob = await registerAgent(app, "r074o-bob@example.com", "r074o_bob");
    await insertBlock(alice.userId, bob.userId);
    await insertBlock(bob.userId, alice.userId);

    const res = await alice.agent.delete(`/api/v1/users/${bob.userId}/ban`);
    expect(res.status).toBe(204);

    const aliceBlocks = await getTestDb()
      .select()
      .from(userBlock)
      .where(eq(userBlock.byId, alice.userId));
    expect(aliceBlocks).toHaveLength(0);

    const bobBlocks = await getTestDb()
      .select()
      .from(userBlock)
      .where(and(eq(userBlock.byId, bob.userId), eq(userBlock.targetId, alice.userId)));
    expect(bobBlocks).toHaveLength(1);
  });

  test("REQ-074 does not touch blocks involving third parties", async () => {
    const alice = await registerAgent(app, "r074t-alice@example.com", "r074t_alice");
    const bob = await registerAgent(app, "r074t-bob@example.com", "r074t_bob");
    const carol = await registerAgent(app, "r074t-carol@example.com", "r074t_carol");
    await insertBlock(alice.userId, bob.userId);
    await insertBlock(alice.userId, carol.userId);

    const res = await alice.agent.delete(`/api/v1/users/${bob.userId}/ban`);
    expect(res.status).toBe(204);

    // alice→carol block survives.
    const carolBlocks = await getTestDb()
      .select()
      .from(userBlock)
      .where(and(eq(userBlock.byId, alice.userId), eq(userBlock.targetId, carol.userId)));
    expect(carolBlocks).toHaveLength(1);
  });
});
