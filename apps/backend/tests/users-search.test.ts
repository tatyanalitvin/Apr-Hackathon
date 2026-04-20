// REQ-UserSearch §2.4 — GET /api/v1/users?q=<term>
// Binding spec: docs/specs/s3-user-search.md §4 R1–R18.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";
import { TEST_PASSWORD_OK } from "./helpers/fixtures";

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
  name = username,
): Promise<SignedUpAgent> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

describe("REQ-UserSearch §2.4 query-shape + auth", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-UserSearch §2.4 R3 — unauthenticated → 401", async () => {
    const res = await request(app.server).get("/api/v1/users?q=bob");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "unauthorized" });
  });

  test("REQ-UserSearch §2.4 R1 — missing q → 400 invalid_query", async () => {
    const alice = await registerAgent(app, "usrch-r1a@example.com", "usrch_r1a");
    const res = await alice.agent.get("/api/v1/users");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });

  test("REQ-UserSearch §2.4 R1 — q.length < 2 → 400 invalid_query", async () => {
    const alice = await registerAgent(app, "usrch-r1b@example.com", "usrch_r1b");
    const res = await alice.agent.get("/api/v1/users?q=a");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });

  test("REQ-UserSearch §2.4 R1 — whitespace-only q → 400 invalid_query", async () => {
    const alice = await registerAgent(app, "usrch-r1c@example.com", "usrch_r1c");
    const res = await alice.agent.get("/api/v1/users?q=%20%20");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });

  test("REQ-UserSearch §2.4 R2 — q.length > 64 → 400 invalid_query", async () => {
    const alice = await registerAgent(app, "usrch-r2@example.com", "usrch_r2");
    const res = await alice.agent.get(`/api/v1/users?q=${"a".repeat(65)}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });
});
