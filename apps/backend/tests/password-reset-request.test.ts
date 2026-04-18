// Task #7 (v3.docx §2.1.4, REQ-017) — POST /api/auth/request-password-reset.
//
// Path is `/request-password-reset`, not `/forget-password`. Verified by
// source-read of node_modules/better-auth/dist/api/routes/password.mjs:20
// (`createAuthEndpoint("/request-password-reset", { method: "POST", ... })`).
// The `/forget-password` path only exists inside better-auth's email-otp
// plugin (not enabled here). Spec §6 task #7 and REQ-table were renamed in
// the same commit; see §10 "task #7 — path name" for why.
//
// The endpoint is reached through our existing /api/auth/* catch-all proxy
// (ADR-0004). There is no app-owned route for this feature — but R15's
// contract is ours to own via integration tests.
//
// R15 coverage (v3.docx §2.1.4, REQ-017 anti-enumeration):
//   - existing email → 200 (sendResetPassword callback fires; token logged)
//   - non-existent email → 200 (better-auth simulates the verification
//     lookup for timing parity; confirmed in password.mjs:56-57)
//
// Both branches returning 200 is *better-auth's* guarantee — see the
// `if (!user) { ... return ctx.json({status: true, message: ... }) }`
// block. R15 therefore doesn't measure timing; it fences the return-200
// invariant so a future better-auth bump that starts 404-ing the
// non-existent branch is caught in CI.
//
// Why no test for pino-log side-effects: the spec's R15 contract is the
// HTTP return. The `sendResetPassword` callback's log shape (email, token,
// prod-redaction to 6 chars) is implementation detail documented inline
// in auth.ts. Adding a log-capture spy would couple the test to pino's
// transport internals for no contract benefit.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";

const seed = {
  email: "reset-anna@example.com",
  username: "reset_anna",
  password: "password1234",
  name: "Reset Anna",
};

describe("REQ-017 R15 /api/auth/request-password-reset returns 200 for any email", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-017 existing email → 200 + no-enumeration payload", async () => {
    await request(app.server)
      .post("/api/auth/sign-up/email")
      .send(seed)
      .expect(200);

    const res = await request(app.server)
      .post("/api/auth/request-password-reset")
      .send({ email: seed.email });

    expect(res.status).toBe(200);
    // better-auth 1.6.5 returns `{status:true, message:"If this email exists..."}`
    // for BOTH branches. The specific wording is library-owned; we only
    // assert the keys so a minor-bump rewording doesn't flake us.
    expect(res.body).toHaveProperty("status", true);
    expect(res.body).toHaveProperty("message");
  });

  test("REQ-017 non-existent email → 200, identical shape (no enumeration)", async () => {
    const res = await request(app.server)
      .post("/api/auth/request-password-reset")
      .send({ email: "nobody@example.com" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", true);
    expect(res.body).toHaveProperty("message");
  });
});
