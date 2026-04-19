// REQ-146 — CSRF double-submit on mutating /api/v1/* endpoints.
//
// Contract (apps/backend/src/lib/csrf.ts):
//   - GET / HEAD / OPTIONS             → header not required
//   - /api/auth/* (better-auth bridge) → header not required
//   - POST|PUT|PATCH|DELETE /api/v1/*  → MUST have both csrf_token cookie
//     and X-CSRF-Token header, and they MUST match. 403 otherwise.
//
// We drive the check against a real route surface that already returns 401
// when unauth'd — POST /api/v1/dms — because the CSRF preHandler is
// registered globally in app.ts and must intercept BEFORE the auth check.
// That ordering matters: CSRF is a cross-origin forgery defense and must
// fire even when no session exists, so an attacker can't learn "is this
// endpoint a valid mutation surface" by the shape of the 401 vs 403.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";

describe("REQ-146 CSRF double-submit preHandler", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const BROWSER_ORIGIN = "http://localhost:3000";

  test("REQ-146 POST /api/v1/dms (browser, no cookie) → 403 csrf_token_missing", async () => {
    const res = await request(app.server)
      .post("/api/v1/dms")
      .set("Origin", BROWSER_ORIGIN)
      .send({ userId: "noop" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_token_missing" });
  });

  test("REQ-146 POST /api/v1/dms (browser, cookie but no header) → 403 csrf_token_missing", async () => {
    const res = await request(app.server)
      .post("/api/v1/dms")
      .set("Origin", BROWSER_ORIGIN)
      .set("Cookie", "csrf_token=abc123")
      .send({ userId: "noop" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_token_missing" });
  });

  test("REQ-146 POST /api/v1/dms (browser, mismatched header) → 403 csrf_token_invalid", async () => {
    const res = await request(app.server)
      .post("/api/v1/dms")
      .set("Origin", BROWSER_ORIGIN)
      .set("Cookie", "csrf_token=abc123")
      .set("X-CSRF-Token", "different-value")
      .send({ userId: "noop" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_token_invalid" });
  });

  test("REQ-146 POST /api/v1/dms (browser, matching token) passes CSRF (falls to 401 auth)", async () => {
    // CSRF passes → request falls through to the handler's own auth check,
    // which returns 401. The CSRF layer is transparent to callers that echo
    // the cookie in the header.
    const res = await request(app.server)
      .post("/api/v1/dms")
      .set("Origin", BROWSER_ORIGIN)
      .set("Cookie", "csrf_token=matching-value")
      .set("X-CSRF-Token", "matching-value")
      .send({ userId: "noop" });
    expect(res.status).toBe(401);
  });

  test("REQ-146 non-browser caller (no Origin/Referer) is exempt", async () => {
    // curl / CLI / backend-to-backend / supertest without Origin is not a
    // CSRF attack vector — CSRF requires a browser the attacker has tricked.
    // Falls through to the route's own auth check (401).
    const res = await request(app.server)
      .post("/api/v1/dms")
      .send({ userId: "noop" });
    expect(res.status).toBe(401);
  });

  test("REQ-146 Referer alone also triggers the browser branch", async () => {
    // Fetch's `referrerPolicy: 'origin'` strips the Origin header but keeps
    // Referer. We must still enforce CSRF in that case.
    const res = await request(app.server)
      .post("/api/v1/dms")
      .set("Referer", `${BROWSER_ORIGIN}/rooms`)
      .send({ userId: "noop" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_token_missing" });
  });

  test("REQ-146 GET /api/v1/dms is exempt — no CSRF header required", async () => {
    const res = await request(app.server)
      .get("/api/v1/dms")
      .set("Origin", BROWSER_ORIGIN);
    // GET is exempt → falls through to the route's own auth check (401).
    expect(res.status).toBe(401);
  });

  test("REQ-146 /api/auth/* is exempt — sign-up works without CSRF header", async () => {
    // better-auth owns this path and runs its own protection. If our
    // preHandler intercepted this, sign-up would fail with 403 before the
    // session cookie was ever issued — chicken-and-egg.
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .set("Origin", BROWSER_ORIGIN)
      .send({
        email: "csrf-exempt@example.com",
        username: "csrf_exempt",
        password: "password1234",
        name: "CSRF Exempt",
      });
    // 200 = sign-up succeeded; anything OTHER than 403 proves the exempt.
    expect(res.status).not.toBe(403);
  });

  test("REQ-146 DELETE /api/v1/attachments/:id goes through CSRF (not multipart-exempt)", async () => {
    // The brief is explicit: DELETE revoke is a regular JSON mutation and
    // MUST go through the CSRF check. No blanket /api/v1/attachments exempt.
    const res = await request(app.server)
      .delete("/api/v1/attachments/fake-id")
      .set("Origin", BROWSER_ORIGIN)
      .send();
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_token_missing" });
  });

  test("REQ-146 POST /api/v1/attachments goes through CSRF (multipart included)", async () => {
    // Multipart upload is not exempt either — the client uses fetch() with
    // headers, so X-CSRF-Token rides alongside the multipart body.
    const res = await request(app.server)
      .post("/api/v1/attachments")
      .set("Origin", BROWSER_ORIGIN)
      .set("Content-Type", "multipart/form-data; boundary=----x")
      .send("");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_token_missing" });
  });
});
