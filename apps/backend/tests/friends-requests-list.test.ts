import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// R14 / R15 / R7 / REQ-056 — GET /api/v1/friends/requests?direction=
// Binding spec: docs/specs/s2-friendship.md §4 R14, R15, R7.
//
// - direction=incoming: rows where toId=caller AND status='pending'
//   AND createdAt > now()-30d (R7 read-side TTL).
// - direction=outgoing: rows where fromId=caller AND status='pending'
//   AND createdAt > now()-30d.
// - Ordered by createdAt DESC (newest first).
// - Joined user profile appears as `from` (incoming) or `to` (outgoing).

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

async function insertFriendRequest(
  fromId: string,
  toId: string,
  opts: {
    status?: "pending" | "accepted" | "rejected";
    message?: string;
    createdAt?: Date;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await getTestDb().insert(friendRequest).values({
    id,
    fromId,
    toId,
    status: opts.status ?? "pending",
    message: opts.message ?? null,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
  return id;
}

describe("REQ-056 GET /api/v1/friends/requests direction filter + 30d TTL", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-056 no cookie → 401 unauthorized", async () => {
    const res = await request(app.server)
      .get("/api/v1/friends/requests?direction=incoming");
    expect(res.status).toBe(401);
  });

  test("REQ-056 direction=incoming returns pending rows ordered createdAt DESC", async () => {
    const alice = await registerAgent(app, "r056i-alice@example.com", "r056i_alice");
    const bob = await registerAgent(app, "r056i-bob@example.com", "r056i_bob");
    const carol = await registerAgent(app, "r056i-carol@example.com", "r056i_carol");

    const olderDate = new Date(Date.now() - 10 * 60_000);
    const newerDate = new Date();
    const olderId = await insertFriendRequest(bob.userId, alice.userId, {
      message: "older",
      createdAt: olderDate,
    });
    const newerIncoming = await insertFriendRequest(carol.userId, alice.userId, {
      message: "newer",
      createdAt: newerDate,
    });
    // Noise — outgoing from alice (must not appear).
    await insertFriendRequest(alice.userId, bob.userId, {
      message: "noise outgoing",
    });

    const res = await alice.agent.get("/api/v1/friends/requests?direction=incoming");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.requests)).toBe(true);
    expect(res.body.requests).toHaveLength(2);
    expect(res.body.requests[0].id).toBe(newerIncoming);
    expect(res.body.requests[1].id).toBe(olderId);
    expect(res.body.requests[0]).toMatchObject({
      message: "newer",
      from: {
        userId: carol.userId,
        username: "r056i_carol",
        name: "r056i_carol",
      },
    });
    expect(typeof res.body.requests[0].createdAt).toBe("string");
    expect(res.body.requests[0].to).toBeUndefined();
  });

  test("REQ-056 direction=outgoing returns pending rows with `to` field", async () => {
    const alice = await registerAgent(app, "r056o-alice@example.com", "r056o_alice");
    const bob = await registerAgent(app, "r056o-bob@example.com", "r056o_bob");

    const rowId = await insertFriendRequest(alice.userId, bob.userId, {
      message: "please be my friend",
    });
    // Noise: an incoming row — must not appear in outgoing.
    await insertFriendRequest(bob.userId, alice.userId);

    const res = await alice.agent.get("/api/v1/friends/requests?direction=outgoing");
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0]).toMatchObject({
      id: rowId,
      message: "please be my friend",
      to: {
        userId: bob.userId,
        username: "r056o_bob",
        name: "r056o_bob",
      },
    });
    expect(res.body.requests[0].from).toBeUndefined();
  });

  test("REQ-056 31-day-old pending row is excluded (R7 TTL filter)", async () => {
    const alice = await registerAgent(app, "r056t-alice@example.com", "r056t_alice");
    const bob = await registerAgent(app, "r056t-bob@example.com", "r056t_bob");

    const stale = new Date(Date.now() - 31 * 24 * 60 * 60_000);
    await insertFriendRequest(bob.userId, alice.userId, {
      message: "stale incoming",
      createdAt: stale,
    });
    await insertFriendRequest(alice.userId, bob.userId, {
      message: "stale outgoing",
      createdAt: stale,
    });

    const inRes = await alice.agent.get("/api/v1/friends/requests?direction=incoming");
    expect(inRes.status).toBe(200);
    expect(inRes.body.requests).toHaveLength(0);

    const outRes = await alice.agent.get("/api/v1/friends/requests?direction=outgoing");
    expect(outRes.status).toBe(200);
    expect(outRes.body.requests).toHaveLength(0);
  });

  test("REQ-056 non-pending rows (accepted/rejected) are excluded", async () => {
    const alice = await registerAgent(app, "r056s-alice@example.com", "r056s_alice");
    const bob = await registerAgent(app, "r056s-bob@example.com", "r056s_bob");

    await insertFriendRequest(bob.userId, alice.userId, { status: "accepted" });
    await insertFriendRequest(alice.userId, bob.userId, { status: "rejected" });

    const inRes = await alice.agent.get("/api/v1/friends/requests?direction=incoming");
    expect(inRes.body.requests).toHaveLength(0);
    const outRes = await alice.agent.get("/api/v1/friends/requests?direction=outgoing");
    expect(outRes.body.requests).toHaveLength(0);
  });

  test("REQ-056 invalid/missing direction → 400 validation", async () => {
    const alice = await registerAgent(app, "r056v-alice@example.com", "r056v_alice");

    const missing = await alice.agent.get("/api/v1/friends/requests");
    expect(missing.status).toBe(400);

    const bad = await alice.agent.get("/api/v1/friends/requests?direction=sideways");
    expect(bad.status).toBe(400);
  });
});
