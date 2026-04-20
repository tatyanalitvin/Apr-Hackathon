import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-146 — csrf_token cookie is issued on successful session establishment
// (sign-up and sign-in). Layered next to the better-auth bridge in app.ts:
// whenever the better-auth response sets an `auth.session_token` cookie
// (which it only does on a successful sign-up, sign-in, or token refresh),
// we also stamp the companion `csrf_token` cookie so the client can start
// double-submitting immediately.
//
// The cookie MUST be readable by JS (NOT HttpOnly) — the client reads it
// via document.cookie and echoes the value in the X-CSRF-Token header.
// SameSite=Strict is non-negotiable; Secure is dev-conditional.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";

function extractCookies(res: request.Response): string[] {
  const raw = res.headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

describe("REQ-146 csrf_token cookie on session establishment", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("sign-up emits a csrf_token cookie alongside the session cookie", async () => {
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "csrf-signup@example.com",
        username: "csrf_signup",
        password: TEST_PASSWORD_OK,
        name: "CSRF Signup",
      })
      .expect(200);

    const cookies = extractCookies(res);
    const session = cookies.find((c) =>
      c.startsWith("better-auth.session_token="),
    );
    const csrf = cookies.find((c) => c.startsWith("csrf_token="));

    expect(session).toBeDefined();
    expect(csrf).toBeDefined();
    // Value must be non-empty — `csrf_token=<token>; ...`
    const tokenValue = csrf!.split(";")[0].split("=")[1];
    expect(tokenValue.length).toBeGreaterThan(10);
    // Must be SameSite=Strict (cross-site forgery defense). NOT HttpOnly.
    expect(csrf!).toMatch(/SameSite=Strict/i);
    expect(csrf!.toLowerCase()).not.toContain("httponly");
  });

  test("sign-in emits a csrf_token cookie on successful auth", async () => {
    // Seed a user first, then sign in.
    await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "csrf-signin@example.com",
        username: "csrf_signin",
        password: TEST_PASSWORD_OK,
        name: "CSRF Signin",
      })
      .expect(200);

    const res = await request(app.server)
      .post("/api/auth/sign-in/email")
      .send({ email: "csrf-signin@example.com", password: TEST_PASSWORD_OK })
      .expect(200);

    const cookies = extractCookies(res);
    const csrf = cookies.find((c) => c.startsWith("csrf_token="));
    expect(csrf).toBeDefined();
    expect(csrf!).toMatch(/SameSite=Strict/i);
  });

  test("failed sign-in does NOT leak a csrf_token cookie", async () => {
    const res = await request(app.server)
      .post("/api/auth/sign-in/email")
      .send({ email: "no-such-user@example.com", password: "wrong" });

    // Regardless of the error status shape (401/400), we must not stamp the
    // cookie on a failed auth — otherwise an attacker could harvest tokens
    // without authenticating.
    const cookies = extractCookies(res);
    const csrf = cookies.find((c) => c.startsWith("csrf_token="));
    expect(csrf).toBeUndefined();
  });
});
