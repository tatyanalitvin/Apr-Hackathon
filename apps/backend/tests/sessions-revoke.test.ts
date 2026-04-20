import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// Task #6b (REQ-019, v3.docx §2.2.4) — DELETE /api/v1/sessions/:id.
//
// We own the ownership guard. better-auth's `auth.api.revokeSession` takes a
// token (not an id) and the Context7 docs are silent on whether it rejects
// tokens belonging to another user. So the wrapper loads the session row by
// :id, asserts `row.userId === caller.user.id`, then calls revokeSession with
// the row's token. On mismatch OR row-not-found we return the SAME 403 so an
// attacker can't probe session id existence.
//
// Why this matters: session ids aren't HttpOnly-protected the way tokens are
// — they appear in the GET /sessions listing, which is served to the caller
// over a legitimate auth'd request. Scoping by userId is the only thing
// standing between a bug in better-auth and a cross-user revoke.
//
// Coverage:
//   - unauthenticated → 401
//   - revoke non-existent id → 403 (same shape as "not yours")
//   - revoke another user's session → 403, victim's session still auths
//   - revoke own non-current session → 204, that cookie stops auth'ing,
//     caller's current cookie still auths (defense-in-depth on the
//     caller-scoped token swap)
//   - revoke own current session → 204, cookie stops auth'ing (logout-like)

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";

const anna = {
  email: "revoke-anna@example.com",
  username: "revoke_anna",
  password: TEST_PASSWORD_OK,
  name: "Revoke Anna",
};
const mallory = {
  email: "revoke-mallory@example.com",
  username: "revoke_mallory",
  password: TEST_PASSWORD_OK,
  name: "Revoke Mallory",
};

describe("REQ-019 DELETE /api/v1/sessions/:id (task #6b)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-019 unauthenticated → 401", async () => {
    const res = await request(app.server).delete("/api/v1/sessions/whatever");
    expect(res.status).toBe(401);
  });

  test("REQ-019 non-existent session id → 403 (existence not leaked)", async () => {
    const agent = request.agent(app.server);
    await agent.post("/api/auth/sign-up/email").send(anna).expect(200);

    const res = await agent.delete("/api/v1/sessions/does-not-exist");
    expect(res.status).toBe(403);

    // Caller is unaffected — and crucially still has their own session row.
    // Tightening from bare status==200: an implementation bug that wrongly
    // revoked the caller's own session when looking up an unknown id would
    // still return 200 from list (empty array under current cookie would 401,
    // but a half-broken path could return 200 with [] for a stale cookie).
    const still = await agent.get("/api/v1/sessions");
    expect(still.status).toBe(200);
    expect(still.body).toHaveLength(1);
    expect(still.body[0].current).toBe(true);
  });

  test("REQ-019 revoking another user's session → 403, victim still auth'd", async () => {
    const annaAgent = request.agent(app.server);
    await annaAgent.post("/api/auth/sign-up/email").send(anna).expect(200);

    const malloryAgent = request.agent(app.server);
    await malloryAgent.post("/api/auth/sign-up/email").send(mallory).expect(200);

    // Mallory lists her sessions to find her own id, then tries to revoke
    // Anna's. Mallory doesn't know Anna's id directly — we cheat by asking
    // Anna for it (this is an integration test, not a pen-test scenario).
    const annaList = await annaAgent.get("/api/v1/sessions");
    expect(annaList.status).toBe(200);
    const annaId = annaList.body[0].id as string;

    const attack = await malloryAgent.delete(`/api/v1/sessions/${annaId}`);
    expect(attack.status).toBe(403);

    // Anna can still use her session.
    const annaStill = await annaAgent.get("/api/v1/sessions");
    expect(annaStill.status).toBe(200);
    expect(annaStill.body).toHaveLength(1);
  });

  test("REQ-019 revoke own non-current session → 204, revoked cookie stops auth'ing, current still works", async () => {
    const a = request.agent(app.server);
    await a.post("/api/auth/sign-up/email").send(anna).expect(200);

    const b = request.agent(app.server);
    await b
      .post("/api/auth/sign-in/email")
      .send({ email: anna.email, password: anna.password })
      .expect(200);

    // From agent A: find the OTHER session (i.e. B's) by picking the row
    // without `current: true`.
    const list = await a.get("/api/v1/sessions");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    const other = list.body.find((s: { current: boolean }) => !s.current) as {
      id: string;
    };
    expect(other).toBeDefined();

    const del = await a.delete(`/api/v1/sessions/${other.id}`);
    expect(del.status).toBe(204);

    // A's cookie still auths.
    const aStill = await a.get("/api/v1/sessions");
    expect(aStill.status).toBe(200);
    expect(aStill.body).toHaveLength(1);

    // B's cookie no longer auths.
    const bDead = await b.get("/api/v1/sessions");
    expect(bDead.status).toBe(401);
  });

  test("REQ-019 revoke own CURRENT session → 204, cookie stops auth'ing (logout-like)", async () => {
    const a = request.agent(app.server);
    await a.post("/api/auth/sign-up/email").send(anna).expect(200);

    const list = await a.get("/api/v1/sessions");
    const mine = list.body[0] as { id: string; current: boolean };
    expect(mine.current).toBe(true);

    const del = await a.delete(`/api/v1/sessions/${mine.id}`);
    expect(del.status).toBe(204);

    const after = await a.get("/api/v1/sessions");
    expect(after.status).toBe(401);
  });
});
