import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-018 — POST /api/auth/reset-password confirms a password reset token.
//
// Endpoint verified in
// node_modules/better-auth/dist/api/routes/password.mjs:120-166:
//   body = { token, newPassword }
//   on success: updates credential password and (because we set
//   revokeSessionsOnPasswordReset: true in auth.ts) drops every active
//   session for the user.
//
// Because this app configures `secondaryStorage` (Redis), better-auth
// stores verification rows in Redis keyed by `verification:reset-password:<token>`
// rather than in the `verification` Postgres table (verified at
// node_modules/better-auth/dist/db/internal-adapter.mjs:567-581). So we
// trigger the reset request through better-auth's own API and read the
// token back from Redis — that's the only place it lives.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { createClient } from "redis";

import { buildApp } from "../src/app";
import { auth } from "../src/auth";

const seed = {
  email: "reset-confirm@example.com",
  username: "reset_confirm",
  password: TEST_PASSWORD_OK,
  name: "Reset Confirm",
};

async function issueResetToken(email: string): Promise<string> {
  await auth.api.requestPasswordReset({ body: { email } });

  // Scan Redis for the verification entry better-auth just wrote.
  const r = createClient({ url: process.env.REDIS_URL });
  await r.connect();
  try {
    const keys: string[] = [];
    for await (const key of r.scanIterator({
      MATCH: "verification:reset-password:*",
    })) {
      if (typeof key === "string") keys.push(key);
      else if (Array.isArray(key)) keys.push(...key);
    }
    expect(keys.length).toBeGreaterThan(0);
    const latest = keys[keys.length - 1];
    return latest.replace(/^verification:reset-password:/, "");
  } finally {
    await r.quit();
  }
}

describe("REQ-018 password reset confirm", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-018 valid token + new password → 200; old password rejected; new password works", async () => {
    await request(app.server)
      .post("/api/auth/sign-up/email")
      .send(seed)
      .expect(200);

    const token = await issueResetToken(seed.email);

    const confirm = await request(app.server)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "newpassword5678" });
    expect(confirm.status).toBe(200);

    const oldPw = await request(app.server)
      .post("/api/auth/sign-in/email")
      .send({ email: seed.email, password: seed.password });
    expect(oldPw.status).toBeGreaterThanOrEqual(400);

    const newPw = await request(app.server)
      .post("/api/auth/sign-in/email")
      .send({ email: seed.email, password: "newpassword5678" });
    expect(newPw.status).toBe(200);
  });

  test("REQ-018 invalid token → 4xx; no password mutation", async () => {
    await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({ ...seed, email: "reset-bad@example.com", username: "reset_bad" })
      .expect(200);

    const res = await request(app.server)
      .post("/api/auth/reset-password")
      .send({ token: "not-a-real-token", newPassword: "neverused5678" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const stillWorks = await request(app.server)
      .post("/api/auth/sign-in/email")
      .send({ email: "reset-bad@example.com", password: seed.password });
    expect(stillWorks.status).toBe(200);
  });

  test("REQ-018 token is single-use — second reset with the same token → 4xx", async () => {
    await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        ...seed,
        email: "reset-once@example.com",
        username: "reset_once",
      })
      .expect(200);

    const token = await issueResetToken("reset-once@example.com");

    const first = await request(app.server)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "firstpass5678" });
    expect(first.status).toBe(200);

    const replay = await request(app.server)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "secondpass5678" });
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.status).toBeLessThan(500);
  });
});
