// Task #5 — logout integration tests (R11, R12) + cookie attributes (R16).
//
// R11 (REQ-015): POST /api/auth/sign-out deletes the session row from Postgres
//   and clears the session cookie. get-session immediately after returns null.
// R12 (REQ-016): The pre-logout cookie, replayed against get-session after
//   sign-out has run, no longer authenticates — the DB row is gone. This is
//   stronger than "the browser forgot the cookie"; it's "the server doesn't
//   honour it even if a malicious client kept a copy".
// R16 (transverse): Set-Cookie on sign-up/sign-in carries HttpOnly,
//   SameSite=Lax, Path=/. `Secure` is absent under NODE_ENV=test (confirmed
//   by source-read of better-auth's createCookieGetter — `secure` is driven
//   by baseURL protocol OR isProduction; our test baseURL is http://... and
//   NODE_ENV=test, so Secure is false in CI). The prod-Secure invariant is
//   documented in §4 R16 but not asserted from tests — there's no test-env
//   lever that flips it without also changing other behaviour, and the
//   source-read is a tighter contract than a round-trip assertion.
//
// Source-read (sign-out.mjs:19-27): the handler fetches the signed cookie
// token, deletes the session row via `internalAdapter.deleteSession`, calls
// `deleteSessionCookie`, and returns `{success: true}` 200 — even when no
// cookie is present. That "always 200" behaviour is why R11 asserts the DB
// row's absence explicitly, not just the response status.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { buildApp } from "../src/app";
import { session, user } from "@ai-herders/shared/schema";
import { getTestDb } from "./db-helpers";

const seed = {
  email: "logout-anna@example.com",
  username: "logout_anna",
  password: "password1234",
  name: "Logout Anna",
};

describe("REQ-015 R11 sign-out deletes session row + clears cookie", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-015 sign-out 200 and session row removed from DB", async () => {
    const agent = request.agent(app.server);
    await agent.post("/api/auth/sign-up/email").send(seed).expect(200);

    const db = getTestDb();
    const [u] = await db.select().from(user).where(eq(user.email, seed.email));
    const before = await db.select().from(session).where(eq(session.userId, u.id));
    expect(before).toHaveLength(1);

    const out = await agent.post("/api/auth/sign-out").send({});
    expect(out.status).toBe(200);

    const after = await db.select().from(session).where(eq(session.userId, u.id));
    expect(after).toHaveLength(0);
  });

  test("REQ-015 get-session immediately after sign-out returns null", async () => {
    const agent = request.agent(app.server);
    await agent.post("/api/auth/sign-up/email").send(seed).expect(200);
    await agent.post("/api/auth/sign-out").send({}).expect(200);

    const me = await agent.get("/api/auth/get-session");
    // better-auth returns null JSON for unauthenticated get-session (not 401).
    // Source: auth/base.mjs — the endpoint is public and resolves to null
    // when no valid session is attached. REQ-015's "null / 401" wording in
    // the spec covers both shapes; pin the actual library behaviour here
    // so a future bump that changes it is caught in CI.
    expect(me.status).toBe(200);
    expect(me.body).toBeNull();
  });
});

describe("REQ-016 R12 post-logout cookie replay does not authenticate", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-016 cached cookie replayed after sign-out → get-session returns null", async () => {
    // Simulates an attacker who captured the session cookie (e.g., via a
    // since-patched XSS) and keeps trying to use it after the legitimate
    // user signed out. The cookie's HMAC still verifies (same
    // SESSION_SECRET) but the DB row is gone — get-session must return
    // null, not honour the stale token.
    const signUp = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send(seed);
    expect(signUp.status).toBe(200);

    const setCookie = signUp.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    // supertest returns Set-Cookie as string[]; each entry is a full
    // `name=value; Path=/; HttpOnly; ...` string. For a Cookie request
    // header we need only the `name=value` pairs, joined by `; `.
    const cookieList = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    const cookiePairs = cookieList.map((c) => c.split(";")[0]).join("; ");

    // Sanity: the cookie authenticates BEFORE sign-out.
    const pre = await request(app.server)
      .get("/api/auth/get-session")
      .set("Cookie", cookiePairs);
    expect(pre.status).toBe(200);
    expect(pre.body?.user?.email).toBe(seed.email);

    // Sign out using the same cookie — server deletes the DB row.
    await request(app.server)
      .post("/api/auth/sign-out")
      .set("Cookie", cookiePairs)
      .send({})
      .expect(200);

    // Replay the captured cookie. HMAC still valid; DB row gone → null.
    const replay = await request(app.server)
      .get("/api/auth/get-session")
      .set("Cookie", cookiePairs);
    expect(replay.status).toBe(200);
    expect(replay.body).toBeNull();
  });
});

describe("R16 session cookie attributes (transverse, REQ-015/016 gate)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("R16 Set-Cookie on sign-up includes HttpOnly, SameSite=Lax, Path=/", async () => {
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send(seed);
    expect(res.status).toBe(200);

    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const raw = Array.isArray(setCookie) ? setCookie.join(" ; ") : String(setCookie);

    // Isolate the session_token cookie specifically — better-auth also
    // emits session_data / dont_remember cookies depending on config, and
    // their attributes may differ. R16's contract is on the session token.
    const sessionCookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).find(
      (c) => typeof c === "string" && c.includes("session_token="),
    );
    expect(sessionCookie).toBeDefined();
    // Attribute checks are case-insensitive; the HTTP spec treats them that way.
    expect(sessionCookie!.toLowerCase()).toContain("httponly");
    expect(sessionCookie!.toLowerCase()).toContain("samesite=lax");
    expect(sessionCookie!.toLowerCase()).toContain("path=/");
    void raw;
  });

  test("R16 under NODE_ENV=test, `Secure` flag is absent (prod-only per §4 R16)", async () => {
    // Source-verified in better-auth's createCookieGetter
    // (dist/cookies/index.mjs:20): secureCookiePrefix = isProduction when
    // baseURL protocol can't be inferred as https. Our test env has
    // WEB_ORIGIN=http://localhost:3000 and NODE_ENV=test — so Secure off,
    // cookie name is the plain `better-auth.session_token` (no __Secure-
    // prefix). This test fences both invariants.
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        ...seed,
        email: "logout-r16-nosecure@example.com",
        username: "logout_r16_nos",
      });
    expect(res.status).toBe(200);

    const setCookie = res.headers["set-cookie"];
    const sessionCookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).find(
      (c) => typeof c === "string" && c.includes("session_token="),
    )!;
    expect(sessionCookie.toLowerCase()).not.toContain("secure");
    expect(sessionCookie).toMatch(/better-auth\.session_token=/);
    expect(sessionCookie).not.toMatch(/__Secure-/);
  });
});
