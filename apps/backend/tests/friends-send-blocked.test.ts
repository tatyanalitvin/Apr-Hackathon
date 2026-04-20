import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// R4 / REQ-053 — sentinel-success when target has blocked caller.
// Binding spec: docs/specs/s2-friendship.md §4 R4, §4 R20.
//
// The endpoint MUST return 201 with the same shape as the real-insert path
// so the block is not leaked to the requester. Zero friend_request rows
// are created for the (fromId, toId) pair.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { friendRequest, user, userBlock } from "@ai-herders/shared/schema";

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

async function insertUserBlock(byId: string, targetId: string): Promise<void> {
  await getTestDb().insert(userBlock).values({ id: randomUUID(), byId, targetId });
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("REQ-053 sentinel-success: blocked sender cannot distinguish", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-053 target blocked caller → 201 pending, zero rows inserted", async () => {
    const alice = await registerAgent(app, "r053-alice@example.com", "r053_alice");
    const bob = await registerAgent(app, "r053-bob@example.com", "r053_bob");
    // Bob blocks Alice.
    await insertUserBlock(bob.userId, alice.userId);

    const res = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "r053_bob", message: "hi" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "pending" });
    expect(typeof res.body.id).toBe("string");
    expect(res.body.id).toMatch(UUID_V4);

    const rows = await getTestDb()
      .select()
      .from(friendRequest)
      .where(
        and(eq(friendRequest.fromId, alice.userId), eq(friendRequest.toId, bob.userId)),
      );
    expect(rows).toHaveLength(0);
  });

  test("REQ-053 shape parity — blocked path keys match real insert", async () => {
    // Three users: carol (real target), eve (sentinel target), alice (sender).
    // Carol does not block alice → real insert. Eve blocks alice → sentinel.
    const alice = await registerAgent(app, "r053p-alice@example.com", "r053p_alice");
    const carol = await registerAgent(app, "r053p-carol@example.com", "r053p_carol");
    const eve = await registerAgent(app, "r053p-eve@example.com", "r053p_eve");
    void carol.userId;
    await insertUserBlock(eve.userId, alice.userId); // eve blocked alice

    const realRes = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "r053p_carol" });
    expect(realRes.status).toBe(201);

    const sentinelRes = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "r053p_eve" });
    expect(sentinelRes.status).toBe(201);

    // Byte-equivalent shape: identical key set, identical value types.
    expect(Object.keys(sentinelRes.body).sort()).toEqual(
      Object.keys(realRes.body).sort(),
    );
    expect(sentinelRes.body.status).toBe(realRes.body.status);
    expect(typeof sentinelRes.body.id).toBe(typeof realRes.body.id);
    expect(sentinelRes.body.id).toMatch(UUID_V4);
    expect(realRes.body.id).toMatch(UUID_V4);
  });

  test("REQ-053 reverse direction — caller blocking target still lets caller send", async () => {
    // REQ-053 is about target→caller block. Caller→target block does NOT
    // sentinel-short-circuit; this is a REAL insert (UI usually suppresses
    // the action, but the backend must not silently drop).
    const gina = await registerAgent(app, "r053-gina@example.com", "r053_gina");
    const hank = await registerAgent(app, "r053-hank@example.com", "r053_hank");
    await insertUserBlock(gina.userId, hank.userId); // gina blocked hank

    const res = await gina.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "r053_hank" });

    expect(res.status).toBe(201);
    const rows = await getTestDb()
      .select()
      .from(friendRequest)
      .where(
        and(eq(friendRequest.fromId, gina.userId), eq(friendRequest.toId, hank.userId)),
      );
    expect(rows).toHaveLength(1);
  });
});
