import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";
import { TEST_PASSWORD_OK } from "./helpers/fixtures";

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
        password: TEST_PASSWORD_OK,
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
        password: TEST_PASSWORD_OK,
        passwordConfirm: "Hackaton_Other_Pw_2026!",
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
        password: TEST_PASSWORD_OK,
        passwordConfirm: TEST_PASSWORD_OK,
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
        password: TEST_PASSWORD_OK,
        name: "No Confirm User",
      });

    expect(res.status).toBe(200);
  });
});

// REQ-006 — password policy: 12–128 byte length (zod shape) + top-10k
// blocklist (backend preHandler). Length checks are satisfied by the
// `.min(12)/.max(128)` on registerSchema; blocklist check is satisfied
// by `passwordPolicyGuard` running AFTER `zodBodyGuard` and BEFORE
// `proxyToBetterAuth` on the sign-up route. Error envelope matches
// `zodBodyGuard` so clients handle all validation issues uniformly.
describe("REQ-006 password policy", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-006 R1 — password shorter than 12 bytes → 400 password_too_short", async () => {
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "req006-short@example.com",
        username: "req006_short",
        password: "short",
        name: "Too Short",
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "validation" });
    const onPw = (res.body.issues ?? []).find(
      (i: { path: (string | number)[] }) => i.path.includes("password"),
    );
    expect(onPw).toBeDefined();
    expect(onPw.message).toMatch(/password_too_short/i);
  });

  test("REQ-006 R2 — password longer than 128 bytes → 400 password_too_long", async () => {
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "req006-long@example.com",
        username: "req006_long",
        password: "A1!".concat("x".repeat(200)),
        name: "Too Long",
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "validation" });
    const onPw = (res.body.issues ?? []).find(
      (i: { path: (string | number)[] }) => i.path.includes("password"),
    );
    expect(onPw).toBeDefined();
    expect(onPw.message).toMatch(/password_too_long/i);
  });

  test("REQ-006 R3 — blocklisted password (password1234) → 400 password_common", async () => {
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "req006-common@example.com",
        username: "req006_common",
        password: "password1234",
        name: "Common Password User",
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "validation" });
    const onPw = (res.body.issues ?? []).find(
      (i: { path: (string | number)[] }) => i.path.includes("password"),
    );
    expect(onPw).toBeDefined();
    expect(onPw.message).toMatch(/password_common/i);
  });

  test("REQ-006 R3 (case variant) — Password1234 also → 400 password_common", async () => {
    // Lowercase-match closes the trivial case-variant bypass. Without
    // this the top-1 blocklist entry is undermined by a single shift
    // key. See password-blocklist.ts for the rationale.
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "req006-common-case@example.com",
        username: "req006_common_case",
        password: "Password1234",
        name: "Common Password Case Variant",
      });

    expect(res.status).toBe(400);
    const onPw = (res.body.issues ?? []).find(
      (i: { path: (string | number)[] }) => i.path.includes("password"),
    );
    expect(onPw?.message).toMatch(/password_common/i);
  });

  test("REQ-006 R4 — cryptographically random 16-char password → 200", async () => {
    // Literal picked for reproducibility. 16 chars, mixed
    // alpha+digit+symbol, not on the Pwdb top-10k (verified at asset
    // commit time in apps/backend/src/lib/password-blocklist.test.ts).
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "req006-ok@example.com",
        username: "req006_ok",
        password: "p7K#vN2mQ!xLj$9W",
        name: "Random Password User",
      });

    expect(res.status).toBe(200);
  });
});
