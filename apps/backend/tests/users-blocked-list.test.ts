// R-extra / REQ-074 — GET /api/v1/users/blocked
// Binding spec: docs/specs/s2-friendship.md §5 (read-side listing, same
// pattern as R1/REQ-050 GET /friends).
//
// Returns the blocks the caller owns: SELECT user_block JOIN user ON
// user.id = user_block.target_id WHERE user_block.by_id = caller.
// Ordered by blockedAt DESC (JS-side sort, same as GET /friends since
// the handler does the same union/sort shape).
// One-way: a block bob→alice does NOT appear in alice's list, only in
// bob's. Unbanning drops the row from the caller's list.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

interface SignedUpAgent {
  agent: request.Agent;
  userId: string;
  username: string;
}

async function userRowByEmail(email: string): Promise<{ id: string; username: string; name: string }> {
  const [row] = await getTestDb()
    .select({ id: user.id, username: user.username, name: user.name })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return { id: row.id, username: row.username ?? "", name: row.name };
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
  const row = await userRowByEmail(email);
  return { agent, userId: row.id, username: row.username };
}

describe("REQ-074 GET /api/v1/users/blocked", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-074 no cookie → 401 unauthorized", async () => {
    const res = await request(app.server).get("/api/v1/users/blocked");
    expect(res.status).toBe(401);
  });

  test("REQ-074 fresh user → 200 { blocked: [] }", async () => {
    const alice = await registerAgent(app, "r074l-empty-alice@example.com", "r074l_empty_alice");
    const res = await alice.agent.get("/api/v1/users/blocked");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ blocked: [] });
  });

  test("REQ-074 single block: caller blocks bob → list contains bob only", async () => {
    const alice = await registerAgent(app, "r074l-one-alice@example.com", "r074l_one_alice");
    const bob = await registerAgent(app, "r074l-one-bob@example.com", "r074l_one_bob");

    await alice.agent.post(`/api/v1/users/${bob.userId}/block`).expect(204);

    const res = await alice.agent.get("/api/v1/users/blocked");
    expect(res.status).toBe(200);
    expect(res.body.blocked).toHaveLength(1);
    expect(res.body.blocked[0]).toMatchObject({
      userId: bob.userId,
      username: "r074l_one_bob",
      name: "r074l_one_bob",
    });
    expect(typeof res.body.blocked[0].blockedAt).toBe("string");
    expect(() => new Date(res.body.blocked[0].blockedAt).toISOString()).not.toThrow();
  });

  test("REQ-074 two blocks → newest first (blockedAt DESC)", async () => {
    const alice = await registerAgent(app, "r074l-ord-alice@example.com", "r074l_ord_alice");
    const bob = await registerAgent(app, "r074l-ord-bob@example.com", "r074l_ord_bob");
    const carol = await registerAgent(app, "r074l-ord-carol@example.com", "r074l_ord_carol");

    await alice.agent.post(`/api/v1/users/${bob.userId}/block`).expect(204);
    // Small gap so blockedAt timestamps differ; Postgres defaultNow()
    // resolves to microseconds, but sequential inserts on some hosts can
    // still land in the same tick.
    await new Promise((r) => setTimeout(r, 15));
    await alice.agent.post(`/api/v1/users/${carol.userId}/block`).expect(204);

    const res = await alice.agent.get("/api/v1/users/blocked");
    expect(res.status).toBe(200);
    expect(res.body.blocked.map((b: { userId: string }) => b.userId)).toEqual([
      carol.userId,
      bob.userId,
    ]);
  });

  test("REQ-074 one-way: bob's view does not include blocks owned by alice", async () => {
    const alice = await registerAgent(app, "r074l-one2-alice@example.com", "r074l_one2_alice");
    const bob = await registerAgent(app, "r074l-one2-bob@example.com", "r074l_one2_bob");

    await alice.agent.post(`/api/v1/users/${bob.userId}/block`).expect(204);

    const res = await bob.agent.get("/api/v1/users/blocked");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ blocked: [] });
  });

  test("REQ-074 unban drops the entry; siblings survive", async () => {
    const alice = await registerAgent(app, "r074l-un-alice@example.com", "r074l_un_alice");
    const bob = await registerAgent(app, "r074l-un-bob@example.com", "r074l_un_bob");
    const carol = await registerAgent(app, "r074l-un-carol@example.com", "r074l_un_carol");

    await alice.agent.post(`/api/v1/users/${bob.userId}/block`).expect(204);
    await alice.agent.post(`/api/v1/users/${carol.userId}/block`).expect(204);
    await alice.agent.delete(`/api/v1/users/${bob.userId}/ban`).expect(204);

    const res = await alice.agent.get("/api/v1/users/blocked");
    expect(res.status).toBe(200);
    expect(res.body.blocked).toHaveLength(1);
    expect(res.body.blocked[0].userId).toBe(carol.userId);
  });
});
