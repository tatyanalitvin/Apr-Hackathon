// Task #3 — register integration tests (R1–R4).
// Exercises POST /api/auth/sign-up/email end-to-end against a real Postgres
// (Testcontainers harness, see docs/adr/0005-test-db-harness.md) so the full
// better-auth → drizzleAdapter → schema stack is covered:
//   - R1 (REQ-001): happy path — user row inserted with name + username
//   - R2 (REQ-001): response Set-Cookie authenticates subsequent get-session
//   - R3 (REQ-003): duplicate email → 4xx, no duplicate row
//   - R4 (REQ-005): duplicate username → 4xx
//
// truncateAll() runs in beforeEach (tests/setup.ts), so each test starts with
// an empty `user`/`account`/`session` state — no cross-test order dependency.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";
import { account, user } from "@ai-herders/shared/schema";
import { getTestDb } from "./db-helpers";

const validRegister = {
  email: "anna@example.com",
  username: "anna_01",
  password: "password1234",
  name: "Anna Example",
};

describe("REQ-001 register happy path persists user row", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-001 POST /api/auth/sign-up/email → 200 and inserts exactly one user row", async () => {
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send(validRegister);

    expect(res.status).toBe(200);

    const db = getTestDb();
    const rows = await db.select().from(user).where(eq(user.email, validRegister.email));
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe(validRegister.username);
  });

  test("REQ-001 user row stores the submitted display name", async () => {
    await request(app.server)
      .post("/api/auth/sign-up/email")
      .send(validRegister)
      .expect(200);

    const db = getTestDb();
    const [row] = await db.select().from(user).where(eq(user.email, validRegister.email));
    expect(row.name).toBe(validRegister.name);
  });

  test("REQ-001 register also creates a better-auth `account` row for the password", async () => {
    // Gate: without the `account` row the user can't sign in later.
    // Cheap check; failure here means the drizzleAdapter wiring regressed.
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send(validRegister);
    expect(res.status).toBe(200);

    const db = getTestDb();
    const [u] = await db.select().from(user).where(eq(user.email, validRegister.email));
    const accounts = await db.select().from(account).where(eq(account.userId, u.id));
    expect(accounts.length).toBeGreaterThanOrEqual(1);
  });
});

describe("REQ-001 register response session cookie authenticates get-session", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-001 Set-Cookie from sign-up authenticates a subsequent get-session call", async () => {
    const agent = request.agent(app.server);

    const signUp = await agent
      .post("/api/auth/sign-up/email")
      .send(validRegister);
    expect(signUp.status).toBe(200);

    const setCookie = signUp.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    // better-auth default cookie name is `better-auth.session_token`.
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie);
    expect(cookieHeader).toMatch(/session/i);

    const session = await agent.get("/api/auth/get-session");
    expect(session.status).toBe(200);
    // get-session returns { user, session } when authenticated (not null / {}).
    expect(session.body).not.toBeNull();
    expect(session.body.user?.email).toBe(validRegister.email);
    expect(session.body.user?.username).toBe(validRegister.username);
  });
});

describe("REQ-003 duplicate email rejected with no duplicate row", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-003 second register with same email → 4xx and table still has one row", async () => {
    const first = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send(validRegister);
    expect(first.status).toBe(200);

    const second = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({ ...validRegister, username: "anna_02" });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);

    const db = getTestDb();
    const rows = await db.select().from(user).where(eq(user.email, validRegister.email));
    expect(rows).toHaveLength(1);
  });
});

describe("REQ-005 duplicate username rejected with no duplicate row", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-005 second register with same username (different email) → 4xx", async () => {
    const first = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send(validRegister);
    expect(first.status).toBe(200);

    const second = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({ ...validRegister, email: "anna2@example.com" });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);

    // Exactly one user with this username.
    const db = getTestDb();
    const rows = await db.select().from(user).where(eq(user.username, validRegister.username));
    expect(rows).toHaveLength(1);
  });
});
