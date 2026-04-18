// Task #4 — login integration tests.
// R7 (REQ-010, REQ-011): sign-in happy path + cookie authenticates get-session.
// R8, R9, R10 land in follow-up commits per the execution order recorded in
// docs/specs/s1-auth.md §6 task #4.
//
// Runs against the Testcontainers harness (ADR-0005). Each test starts with a
// freshly TRUNCATEd DB — the register call at the top of every test seeds its
// own user so there's no cross-test state dependency.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";

const seed = {
  email: "login-anna@example.com",
  username: "login_anna",
  password: "password1234",
  name: "Login Anna",
};

describe("REQ-010 REQ-011 login happy path (R7)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-010 POST /api/auth/sign-in/email with correct creds → 200 + Set-Cookie", async () => {
    // Seed: register via the same app so the `account` + password hash are
    // real better-auth artefacts. Using a fresh agent for sign-in means the
    // cookie path under test isn't polluted by the register cookie.
    await request(app.server)
      .post("/api/auth/sign-up/email")
      .send(seed)
      .expect(200);

    const res = await request(app.server)
      .post("/api/auth/sign-in/email")
      .send({ email: seed.email, password: seed.password });
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  test("REQ-011 cookie from sign-in authenticates GET /api/auth/get-session", async () => {
    // Register in a separate flow, then log in via a supertest.agent so the
    // cookie jar carries Set-Cookie forward into the get-session call.
    await request(app.server)
      .post("/api/auth/sign-up/email")
      .send(seed)
      .expect(200);

    const agent = request.agent(app.server);
    const login = await agent
      .post("/api/auth/sign-in/email")
      .send({ email: seed.email, password: seed.password });
    expect(login.status).toBe(200);

    const session = await agent.get("/api/auth/get-session");
    expect(session.status).toBe(200);
    expect(session.body).not.toBeNull();
    expect(session.body.user?.email).toBe(seed.email);
    expect(session.body.user?.username).toBe(seed.username);
  });
});
