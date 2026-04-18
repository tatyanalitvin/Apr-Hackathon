// Task #4 — login integration tests.
// R7 (REQ-010, REQ-011): sign-in happy path + cookie authenticates get-session.
// R8 (REQ-012): rememberMe toggles the session-cookie persistence attribute.
// R9, R10 land in follow-up commits per the execution order recorded in
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

describe("REQ-012 rememberMe cookie-attribute contract (R8)", () => {
  // Why cookie-attribute instead of absolute expiresAt thresholds:
  // v3.docx §2.2.2 (organizer gate) says "persistent login across browser
  // close/reopen" with no day-counts. better-auth 1.6.5 source (sign-in.mjs)
  // sets Max-Age on the session cookie only when rememberMe is truthy;
  // without rememberMe the cookie has no Max-Age and the browser discards
  // it on close. That IS the v3 contract. See s1-auth.md §10 decision log.
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  // Return the session-token Set-Cookie line (the one with "session_token"
  // in its name). Auxiliary cookies like dont-remember-token are ignored.
  function sessionCookie(setCookie: string | string[] | undefined): string {
    const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const line = arr.find((c) => /session_token=/i.test(c));
    if (!line) throw new Error(`no session_token cookie in Set-Cookie: ${JSON.stringify(arr)}`);
    return line;
  }

  test("REQ-012 rememberMe: true → session_token cookie carries Max-Age (persistent)", async () => {
    await request(app.server)
      .post("/api/auth/sign-up/email")
      .send(seed)
      .expect(200);

    const res = await request(app.server)
      .post("/api/auth/sign-in/email")
      .send({ email: seed.email, password: seed.password, rememberMe: true });
    expect(res.status).toBe(200);

    const cookie = sessionCookie(res.headers["set-cookie"]);
    expect(cookie.toLowerCase()).toMatch(/max-age=\d+/);
  });

  test("REQ-012 rememberMe: false → session_token cookie omits Max-Age (session cookie)", async () => {
    await request(app.server)
      .post("/api/auth/sign-up/email")
      .send(seed)
      .expect(200);

    const res = await request(app.server)
      .post("/api/auth/sign-in/email")
      .send({ email: seed.email, password: seed.password, rememberMe: false });
    expect(res.status).toBe(200);

    const cookie = sessionCookie(res.headers["set-cookie"]);
    expect(cookie.toLowerCase()).not.toMatch(/max-age=/);
  });

  // Intentionally no test for the `rememberMe` field omitted: better-auth
  // 1.6.5 treats omitted as persistent (Max-Age = expiresIn). The v3 gate
  // ("Keep me signed in" checkbox) requires the frontend to always send a
  // boolean, so server behaviour for the omitted case is implementation-
  // defined. Documented in docs/specs/s1-auth.md §10 decision log.
});
