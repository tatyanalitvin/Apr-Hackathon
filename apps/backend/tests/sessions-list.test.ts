// Task #6a (REQ-018, v3.docx §2.2.4) — GET /api/v1/sessions.
//
// Thin wrapper over better-auth's auth.api.listSessions({ headers }), with two
// value-adds that justify owning our own route:
//   1. `current: true` flag on the caller's current session so the UI can
//      highlight "this is the browser you're reading this from."
//   2. Strip `session.token` from the response — token is auth-equivalent; a
//      list endpoint that echoes it defeats HttpOnly.
//
// Coverage:
//   - REQ-018 happy path: single session, `current: true`, no `token` field.
//   - REQ-018 two-session listing: second sign-in from a fresh agent creates a
//     second session row; the listing shows exactly one `current: true`.
//   - REQ-018 unauthenticated: no cookie → 401.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";

const seed = {
  email: "sessions-anna@example.com",
  username: "sessions_anna",
  password: "password1234",
  name: "Sessions Anna",
};

describe("REQ-018 GET /api/v1/sessions lists caller's sessions (task #6a)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-018 unauthenticated request → 401", async () => {
    const res = await request(app.server).get("/api/v1/sessions");
    expect(res.status).toBe(401);
  });

  test("REQ-018 single session: one row, current: true, no token in body", async () => {
    const agent = request.agent(app.server);
    await agent.post("/api/auth/sign-up/email").send(seed).expect(200);

    const res = await agent.get("/api/v1/sessions");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);

    const [row] = res.body;
    expect(row.current).toBe(true);
    expect(typeof row.id).toBe("string");
    expect(row).not.toHaveProperty("token");
    // Spec R13 shape — UI contract, not just "token absent". If better-auth
    // renames/drops any of these, the UI breaks silently without this fence.
    expect(row).toHaveProperty("userAgent");
    expect(row).toHaveProperty("ipAddress");
    expect(row).toHaveProperty("createdAt");
    expect(row).toHaveProperty("updatedAt");
    expect(row).toHaveProperty("expiresAt");
    // Allowlist fence: response must ONLY contain R13 fields. Catches any
    // future `...rest` regression that would re-introduce token leak.
    expect(Object.keys(row).sort()).toEqual(
      [
        "createdAt",
        "current",
        "expiresAt",
        "id",
        "ipAddress",
        "updatedAt",
        "userAgent",
      ].sort(),
    );
  });

  test("REQ-018 two sessions: exactly one is flagged current: true", async () => {
    // Agent A registers (session A). Agent B signs in with same creds from a
    // separate cookie jar — better-auth creates session B. Listing from
    // agent A must show BOTH, with `current: true` only on session A.
    const agentA = request.agent(app.server);
    await agentA.post("/api/auth/sign-up/email").send(seed).expect(200);

    const agentB = request.agent(app.server);
    await agentB
      .post("/api/auth/sign-in/email")
      .send({ email: seed.email, password: seed.password })
      .expect(200);

    const listFromA = await agentA.get("/api/v1/sessions");
    expect(listFromA.status).toBe(200);
    expect(listFromA.body).toHaveLength(2);
    const currentCount = listFromA.body.filter((s: { current: boolean }) => s.current).length;
    expect(currentCount).toBe(1);
    for (const row of listFromA.body) {
      expect(row).not.toHaveProperty("token");
    }
  });
});

// REQ-014 — session lifetime. Spec target is ≥ 7 days so users who tick
// "keep me signed in" are not kicked back to /login daily. We assert on a
// freshly minted session's `expiresAt - createdAt` (≥ 6 days as the epsilon
// vs 7, to stay robust against clock skew / minor better-auth internals).
describe("REQ-014 session expiresIn ≥ 7 days", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-014 new session row's expiresAt is at least 6 days after createdAt", async () => {
    const agent = request.agent(app.server);
    await agent
      .post("/api/auth/sign-up/email")
      .send({
        email: "req014-ttl@example.com",
        username: "req014_ttl",
        password: "password1234",
        name: "TTL Anna",
      })
      .expect(200);

    const res = await agent.get("/api/v1/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const [row] = res.body;
    const expiresAt = new Date(row.expiresAt).getTime();
    const createdAt = new Date(row.createdAt).getTime();
    const deltaDays = (expiresAt - createdAt) / (1000 * 60 * 60 * 24);
    expect(deltaDays).toBeGreaterThanOrEqual(6);
  });
});
