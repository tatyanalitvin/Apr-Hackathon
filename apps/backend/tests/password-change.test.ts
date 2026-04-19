// REQ-016 — password change via better-auth's POST /api/auth/change-password.
// Endpoint verified in node_modules/better-auth/dist/api/routes/update-user.d.mts
// (line 87-94): body = { currentPassword, newPassword, revokeOtherSessions? }.
// No bespoke Fastify route needed — the better-auth catch-all in app.ts handles
// /api/auth/* and the endpoint ships out of the box.
//
// Coverage:
//   - happy path: sign in with new password works; old password stops working
//   - wrong current password → 4xx, no DB mutation
//   - revokeOtherSessions=true: a second session on the same user is dropped
//     to 1 after the password change

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";

const baseCreds = {
  email: "req016-ana@example.com",
  username: "req016_ana",
  password: "password1234",
  name: "REQ-016 Ana",
};

describe("REQ-016 password change via better-auth", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-016 happy path — new password accepted; old rejected; new works", async () => {
    const agent = request.agent(app.server);
    await agent
      .post("/api/auth/sign-up/email")
      .send(baseCreds)
      .expect(200);

    const changeRes = await agent
      .post("/api/auth/change-password")
      .send({
        currentPassword: baseCreds.password,
        newPassword: "newpassword5678",
        revokeOtherSessions: false,
      });
    expect(changeRes.status).toBe(200);

    // Fresh agent (no cookies) — old password must be rejected
    const oldPwAgent = request.agent(app.server);
    const oldPwRes = await oldPwAgent
      .post("/api/auth/sign-in/email")
      .send({ email: baseCreds.email, password: baseCreds.password });
    expect(oldPwRes.status).toBeGreaterThanOrEqual(400);

    // Fresh agent — new password MUST work
    const newPwAgent = request.agent(app.server);
    const newPwRes = await newPwAgent
      .post("/api/auth/sign-in/email")
      .send({ email: baseCreds.email, password: "newpassword5678" });
    expect(newPwRes.status).toBe(200);
  });

  test("REQ-016 wrong current password → 4xx; credentials unchanged", async () => {
    const agent = request.agent(app.server);
    await agent
      .post("/api/auth/sign-up/email")
      .send({ ...baseCreds, email: "req016-wc@example.com", username: "req016_wc" })
      .expect(200);

    const res = await agent
      .post("/api/auth/change-password")
      .send({
        currentPassword: "this-is-wrong-password",
        newPassword: "attempted5678",
        revokeOtherSessions: false,
      });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    // Original creds still work — fresh agent sanity check
    const fresh = request.agent(app.server);
    const signIn = await fresh
      .post("/api/auth/sign-in/email")
      .send({ email: "req016-wc@example.com", password: baseCreds.password });
    expect(signIn.status).toBe(200);
  });

  test("REQ-016 revokeOtherSessions=true drops other sessions, keeping the caller's", async () => {
    const agentA = request.agent(app.server);
    await agentA
      .post("/api/auth/sign-up/email")
      .send({ ...baseCreds, email: "req016-rev@example.com", username: "req016_rev" })
      .expect(200);

    // Second device (separate cookie jar) signs in with the same creds.
    const agentB = request.agent(app.server);
    await agentB
      .post("/api/auth/sign-in/email")
      .send({ email: "req016-rev@example.com", password: baseCreds.password })
      .expect(200);

    // Pre-check: A should see 2 sessions.
    const before = await agentA.get("/api/v1/sessions");
    expect(before.status).toBe(200);
    expect(before.body).toHaveLength(2);

    const changeRes = await agentA
      .post("/api/auth/change-password")
      .send({
        currentPassword: baseCreds.password,
        newPassword: "rotated5678xyz",
        revokeOtherSessions: true,
      });
    expect(changeRes.status).toBe(200);

    // After: A (the caller) still has a session; B is revoked.
    const after = await agentA.get("/api/v1/sessions");
    expect(after.status).toBe(200);
    expect(after.body).toHaveLength(1);
    expect(after.body[0].current).toBe(true);
  });
});
