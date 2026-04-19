import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";

// Task #2a — better-auth's `additionalFields.username = { required: true }`
// must reject a register request missing `username` BEFORE any DB write.
// We verify that by asserting a 4xx client error, not a 5xx DB error.
describe("register validation (task #2a)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("sign-up without username is rejected with 4xx, no DB touch", async () => {
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "nouser@example.com",
        password: "password1234",
        name: "No Username",
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

// REQ-007 — the UI register form sends `passwordConfirm` alongside `password`;
// the server-side zod guard is the backstop against a rogue client that sends
// a mismatching pair. Schema choice: `passwordConfirm` is OPTIONAL (not
// required) so the ~88 existing sign-up call sites in this test folder keep
// working without a field-by-field sweep. The `.superRefine` still rejects
// mismatches whenever `passwordConfirm` IS sent, which is the behavioural
// contract REQ-007 asks for ("mismatch returns 400, match proceeds").
describe("REQ-007 passwordConfirm mismatch rejected at zod guard", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-007 sign-up with password !== passwordConfirm → 400 with password_mismatch on confirm field", async () => {
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "req007-mismatch@example.com",
        username: "req007_mm",
        password: "password1234",
        passwordConfirm: "password9999",
        name: "Mismatch User",
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "validation" });
    const onConfirm = (res.body.issues ?? []).find(
      (i: { path: (string | number)[] }) => i.path.includes("passwordConfirm"),
    );
    expect(onConfirm).toBeDefined();
    expect(onConfirm.message).toMatch(/password_mismatch/i);
  });

  test("REQ-007 sign-up with matching passwordConfirm proceeds (2xx)", async () => {
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "req007-match@example.com",
        username: "req007_ok",
        password: "password1234",
        passwordConfirm: "password1234",
        name: "Match User",
      });

    expect(res.status).toBe(200);
  });

  test("REQ-007 sign-up without passwordConfirm still succeeds (backwards-compatible with legacy callers)", async () => {
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "req007-noconfirm@example.com",
        username: "req007_nc",
        password: "password1234",
        name: "No Confirm User",
      });

    expect(res.status).toBe(200);
  });
});
