import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-127 (v3.docx §2.2) — the export endpoint MUST require an authenticated
// session. Unauthenticated callers get 401; two authenticated callers only
// ever see their own data (no bleed across accounts).

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

describe("REQ-127 export endpoint auth-gated", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-127 no cookie → 401", async () => {
    const res = await request(app.server).post("/api/v1/users/me/export");
    expect(res.status).toBe(401);
  });

  test("REQ-127 two accounts see only their own data", async () => {
    const alice = await registerAgent(app, "auth-alice@example.com", "auth_alice");
    const bob = await registerAgent(app, "auth-bob@example.com", "auth_bob");

    const aliceRes = await alice.agent.post("/api/v1/users/me/export").expect(200);
    expect(aliceRes.body.user.id).toBe(alice.userId);
    expect(aliceRes.body.user.email).toBe("auth-alice@example.com");
    expect(aliceRes.body.user.username).toBe("auth_alice");

    const bobRes = await bob.agent.post("/api/v1/users/me/export").expect(200);
    expect(bobRes.body.user.id).toBe(bob.userId);
    expect(bobRes.body.user.email).toBe("auth-bob@example.com");
    expect(bobRes.body.user.username).toBe("auth_bob");

    // Hardest assertion — bob's payload doesn't mention alice's username or
    // email anywhere in its JSON serialization.
    const bobJson = JSON.stringify(bobRes.body);
    expect(bobJson).not.toContain("auth_alice");
    expect(bobJson).not.toContain("auth-alice@example.com");
  });
});
