import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-019 + REQ-003 — the deleted-account guard must match the storage
// invariant. REQ-003 shipped case-insensitive uniqueness (better-auth 1.6.5
// lowercases at write, `user_email_ci_uq` on LOWER(email)), so a tombstoned
// row is always lowercase. A case-sensitive `eq(user.email, email)` lookup
// lets a mixed-case sign-in ("Foo@X.com") bypass the guard and land on
// better-auth's native path — which doesn't know about `deletedAt` and will
// happily issue a session cookie for a soft-deleted account.
//
// This test sits alongside the lowercase-path sibling
// (`account-login-after-delete.test.ts`) and pins the case-normalisation
// contract independently.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";

const seed = {
  email: "s2del-login-case@example.com",
  username: "s2del_login_case",
  password: TEST_PASSWORD_OK,
  name: "Login After Delete Case",
};

describe("REQ-019 login rejected after account deletion — mixed-case email", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("sign-up (lowercase) → delete → sign-in (mixed case) → 4xx, no new session", async () => {
    const agent = request.agent(app.server);
    await agent.post("/api/auth/sign-up/email").send(seed).expect(200);

    const del = await agent
      .delete("/api/v1/users/me")
      .send({ password: seed.password });
    expect(del.status).toBe(204);

    // Mixed-case variant of the same email. REQ-003 lowercases at write
    // so the stored row is `s2del-login-case@example.com`; the guard must
    // normalise the lookup key to match.
    const upper = "S2Del-Login-Case@Example.COM";
    expect(upper.toLowerCase()).toBe(seed.email);

    const fresh = request.agent(app.server);
    const signIn = await fresh
      .post("/api/auth/sign-in/email")
      .send({ email: upper, password: seed.password });
    expect(signIn.status).toBeGreaterThanOrEqual(400);
    expect(signIn.status).toBeLessThan(500);

    const after = await fresh.get("/api/v1/sessions");
    expect(after.status).toBe(401);
  });
});
