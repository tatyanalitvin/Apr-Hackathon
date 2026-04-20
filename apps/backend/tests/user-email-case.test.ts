import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-003 — case-insensitive email uniqueness.
//
// v3.docx §2.1.2 says "Email must be unique," which in web-chat convention
// means case-insensitive. FOLLOWUPS.md ADR-0006 row 1 tracks this as drift;
// this test locks in the contract so the drift can be struck from the list.
//
// Two layers matter:
//   - App layer: better-auth 1.6.5 normalizes email on sign-up + findUserByEmail
//     (sign-up.mjs:163 + internal-adapter.mjs:448).
//   - DB layer: `user_email_ci_uq` (LOWER(email) unique index) keeps any
//     future code path that bypasses better-auth from ever storing two rows
//     whose emails differ only in case.
//
// Both layers are expected to stay green together — if either regresses the
// other catches the defect here.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";

import { buildApp } from "../src/app";
import { user } from "@ai-herders/shared/schema";
import { getTestDb } from "./db-helpers";

describe("REQ-003 email uniqueness is case-insensitive", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-003 second sign-up with same email in different case rejected (no duplicate row)", async () => {
    const first = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "Alice@example.com",
        username: "alice_01",
        password: TEST_PASSWORD_OK,
        name: "Alice",
      });
    expect(first.status).toBe(200);

    const second = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "alice@example.com",
        username: "alice_02",
        password: TEST_PASSWORD_OK,
        name: "Alice",
      });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);

    // Exactly one user row under the case-insensitive lookup.
    const db = getTestDb();
    const rows = await db
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(sql`lower(${user.email}) = 'alice@example.com'`);
    expect(rows).toHaveLength(1);
  });

  test("REQ-003 email is stored lowercased regardless of signup casing", async () => {
    await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "MiXeD@Example.COM",
        username: "mixed_case_1",
        password: TEST_PASSWORD_OK,
        name: "Mixed",
      })
      .expect(200);

    const db = getTestDb();
    const [row] = await db
      .select({ email: user.email })
      .from(user)
      .where(sql`lower(${user.email}) = 'mixed@example.com'`);
    expect(row).toBeDefined();
    expect(row.email).toBe("mixed@example.com");
  });
});

describe("REQ-003 sign-in accepts any case variation of a registered email", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-003 sign-in with UPPERCASE variant of lowercase-registered email → 200", async () => {
    await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "case@example.com",
        username: "case_a",
        password: TEST_PASSWORD_OK,
        name: "Case A",
      })
      .expect(200);

    const res = await request(app.server)
      .post("/api/auth/sign-in/email")
      .send({ email: "CASE@EXAMPLE.COM", password: TEST_PASSWORD_OK });
    expect(res.status).toBe(200);
  });

  test("REQ-003 sign-in with lowercase variant of MixedCase-registered email → 200", async () => {
    await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "BoB@Example.com",
        username: "case_b",
        password: TEST_PASSWORD_OK,
        name: "Case B",
      })
      .expect(200);

    const res = await request(app.server)
      .post("/api/auth/sign-in/email")
      .send({ email: "bob@example.com", password: TEST_PASSWORD_OK });
    expect(res.status).toBe(200);
  });
});

// REQ-003 defense-in-depth — the LOWER(email) unique index catches any row
// that sidesteps better-auth (raw INSERT, external job, etc.). If the
// migration regresses, this direct-INSERT test turns red.
describe("REQ-003 LOWER(email) unique index rejects case-variant duplicates", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-003 direct INSERT of a case-variant email violates user_email_ci_uq", async () => {
    const db = getTestDb();
    await db.insert(user).values({
      id: "u-ci-1",
      name: "CI Uno",
      email: "ci-one@example.com",
      username: "ci_uno",
    });

    // Second INSERT with a mixed-case variant of the same email — the
    // expression index on LOWER(email) must reject it.
    await expect(
      db.insert(user).values({
        id: "u-ci-2",
        name: "CI Duo",
        email: "CI-ONE@Example.com",
        username: "ci_duo",
      }),
    ).rejects.toThrow();
  });
});
