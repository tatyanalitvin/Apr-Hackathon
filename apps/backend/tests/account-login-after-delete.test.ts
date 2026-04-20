import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-019 (v3.docx §2.2) — after `DELETE /api/v1/users/me`, the same email +
// password must not open a new session. Soft-deleted users are tombstones:
// the row stays for message-FK integrity but the account is inert.
//
// Written failing against the bare delete route from commit 4 — the pre-auth
// guard that enforces this contract is commit 6 (in `src/app.ts`). The DB
// cascade alone is insufficient: better-auth's `/sign-in/email` endpoint
// doesn't look at `user.deletedAt`, so without the guard it would happily
// issue a new session row for a tombstoned account.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";

const seed = {
  email: "s2del-login@example.com",
  username: "s2del_login",
  password: TEST_PASSWORD_OK,
  name: "Login After Delete",
};

describe("REQ-019 login rejected after account deletion", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-019 sign-up → delete → sign-in with correct creds → 4xx, no new session", async () => {
    const agent = request.agent(app.server);
    await agent.post("/api/auth/sign-up/email").send(seed).expect(200);

    // Pre-delete sanity: the sign-up cookie auths against a protected route.
    await agent.get("/api/v1/sessions").expect(200);

    const del = await agent
      .delete("/api/v1/users/me")
      .send({ password: seed.password });
    expect(del.status).toBe(204);

    // Fresh request agent so no cookies bleed from the pre-delete session.
    const fresh = request.agent(app.server);
    const signIn = await fresh
      .post("/api/auth/sign-in/email")
      .send({ email: seed.email, password: seed.password });
    expect(signIn.status).toBeGreaterThanOrEqual(400);
    expect(signIn.status).toBeLessThan(500);

    // Whatever cookie (if any) came back must not auth.
    const after = await fresh.get("/api/v1/sessions");
    expect(after.status).toBe(401);
  });
});
