import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-088 integration tests — private-room create + catalog exclusion.
// Binding spec: docs/specs/s2-invitations.md §4 R1 + R2.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { room, user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { flushRedis, getTestDb } from "./db-helpers";

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

describe("REQ-088 POST /api/v1/rooms — private visibility", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await flushRedis();
  });

  test("REQ-088 R2 default visibility=public when field omitted", async () => {
    const alice = await registerAgent(app, "r088d@example.com", "r088_d");
    const res = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "Default Vis" });
    expect(res.status).toBe(201);
    expect(res.body.visibility).toBe("public");

    const [roomRow] = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.id, res.body.id));
    expect(roomRow?.visibility).toBe("public");
  });

  test("REQ-088 R2 creates private room when visibility='private' supplied", async () => {
    const alice = await registerAgent(app, "r088p@example.com", "r088_p");
    const res = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "Core Team R088", visibility: "private" });
    expect(res.status).toBe(201);
    expect(res.body.visibility).toBe("private");

    const [roomRow] = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.id, res.body.id));
    expect(roomRow?.visibility).toBe("private");
  });

  test("REQ-088 R2 rejects invalid visibility value with 400", async () => {
    const alice = await registerAgent(app, "r088x@example.com", "r088_x");
    const res = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "Invalid Vis", visibility: "secret" });
    expect(res.status).toBe(400);
  });
});

describe("REQ-088 GET /api/v1/rooms — private rooms excluded from catalog", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await flushRedis();
  });

  test("REQ-088 R1 non-member catalog does NOT include private rooms", async () => {
    const alice = await registerAgent(app, "r088a@example.com", "r088_cat_a");
    const bob = await registerAgent(app, "r088b@example.com", "r088_cat_b");

    // Alice creates one public and one private.
    const pubRes = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "Pub Room R088", visibility: "public" });
    expect(pubRes.status).toBe(201);
    const privRes = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "Priv Room R088", visibility: "private" });
    expect(privRes.status).toBe(201);

    // Bob (non-member of both) lists the catalog.
    const catalog = await bob.agent.get("/api/v1/rooms");
    expect(catalog.status).toBe(200);
    const names = (catalog.body.rooms as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain("Pub Room R088");
    expect(names).not.toContain("Priv Room R088");
  });

  test("REQ-088 R1 member sees private room in /rooms/me", async () => {
    const alice = await registerAgent(app, "r088m@example.com", "r088_me_a");

    const privRes = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "My Priv Room R088", visibility: "private" });
    expect(privRes.status).toBe(201);

    const me = await alice.agent.get("/api/v1/rooms/me");
    expect(me.status).toBe(200);
    const names = (me.body.rooms as Array<{ name: string; visibility: string }>).map(
      (r) => r.name,
    );
    expect(names).toContain("My Priv Room R088");
    const priv = (me.body.rooms as Array<{ name: string; visibility: string }>).find(
      (r) => r.name === "My Priv Room R088",
    );
    expect(priv?.visibility).toBe("private");
  });
});
