// R2 / REQ-051 — POST /api/v1/friends/requests happy path.
// Binding spec: docs/specs/s2-friendship.md §4 R2.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
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

describe("REQ-051 POST /api/v1/friends/requests happy path", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-051 no cookie → 401 unauthorized", async () => {
    const res = await request(app.server)
      .post("/api/v1/friends/requests")
      .send({ toUsername: "someone" });
    expect(res.status).toBe(401);
  });

  test("REQ-051 toUsername branch — inserts pending row, returns 201", async () => {
    const alice = await registerAgent(app, "r051-alice@example.com", "r051_alice");
    const bob = await registerAgent(app, "r051-bob@example.com", "r051_bob");

    const res = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "r051_bob", message: "hi bob" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "pending" });
    expect(typeof res.body.id).toBe("string");
    expect(res.body.id.length).toBeGreaterThan(0);

    const rows = await getTestDb()
      .select()
      .from(friendRequest)
      .where(
        and(eq(friendRequest.fromId, alice.userId), eq(friendRequest.toId, bob.userId)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].message).toBe("hi bob");
  });

  test("REQ-051 toUserId branch — inserts pending row, returns 201", async () => {
    const alice = await registerAgent(app, "r051-alice2@example.com", "r051_alice2");
    const bob = await registerAgent(app, "r051-bob2@example.com", "r051_bob2");

    const res = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUserId: bob.userId });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "pending" });
    expect(typeof res.body.id).toBe("string");

    const rows = await getTestDb()
      .select()
      .from(friendRequest)
      .where(
        and(eq(friendRequest.fromId, alice.userId), eq(friendRequest.toId, bob.userId)),
      );
    expect(rows).toHaveLength(1);
  });

  test("REQ-051 unknown username → 404 user_not_found", async () => {
    const alice = await registerAgent(app, "r051-alice3@example.com", "r051_alice3");

    const res = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "nonexistent_user_xyz" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "user_not_found" });
  });

  test("REQ-051 unknown userId → 404 user_not_found", async () => {
    const alice = await registerAgent(app, "r051-alice4@example.com", "r051_alice4");

    const res = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUserId: "does-not-exist-id" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "user_not_found" });
  });

  test("REQ-051 self-request by username → 400 self_request", async () => {
    const alice = await registerAgent(app, "r051-selfu@example.com", "r051_selfu");

    const res = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "r051_selfu" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "self_request" });
  });

  test("REQ-051 self-request by userId → 400 self_request", async () => {
    const alice = await registerAgent(app, "r051-selfid@example.com", "r051_selfid");

    const res = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUserId: alice.userId });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "self_request" });
  });

  test("REQ-051 invalid body shape → 400 validation", async () => {
    const alice = await registerAgent(app, "r051-bad@example.com", "r051_bad");

    const res = await alice.agent.post("/api/v1/friends/requests").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation");
  });

  test("REQ-051 message over 500 chars → 400 validation", async () => {
    const alice = await registerAgent(app, "r051-long@example.com", "r051_long");
    const bob = await registerAgent(app, "r051-longb@example.com", "r051_longb");
    void bob.userId;

    const res = await alice.agent.post("/api/v1/friends/requests").send({
      toUsername: "r051_longb",
      message: "x".repeat(501),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation");
  });
});
