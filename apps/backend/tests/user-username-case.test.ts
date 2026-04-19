// REQ-005 — case-insensitive username uniqueness.
//
// v3.docx §2.1.2 says "Username must be unique" and — per ADR-0006 deviations
// row 2 in FOLLOWUPS.md — the contract is case-insensitive (web-chat
// convention: @Alice and @alice MUST NOT coexist).
//
// Two layers matter, same pattern as the email test:
//   - App layer: a sign-up normalization hook lowercases `username` before
//     better-auth writes the row (better-auth itself does not normalize
//     additional user fields — verified by reading
//     node_modules/better-auth/dist/api/routes/sign-up.mjs).
//   - DB layer: `user_username_ci_uq` (LOWER(username) unique index) catches
//     any code path that bypasses the hook.
//
// Username is immutable post-registration (v3 §2.1.2), so the normalization
// only fires at create-time — no update path to police.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

import { buildApp } from "../src/app";
import { user } from "@ai-herders/shared/schema";
import { getTestDb } from "./db-helpers";

describe("REQ-005 username uniqueness is case-insensitive", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-005 second sign-up with same username in different case rejected", async () => {
    const first = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "u1@example.com",
        username: "Alice",
        password: "password1234",
        name: "Alice",
      });
    expect(first.status).toBe(200);

    const second = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "u2@example.com",
        username: "alice",
        password: "password1234",
        name: "Alice2",
      });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);

    const db = getTestDb();
    const rows = await db
      .select({ id: user.id, username: user.username })
      .from(user)
      .where(sql`lower(${user.username}) = 'alice'`);
    expect(rows).toHaveLength(1);
  });

  test("REQ-005 username is stored lowercased regardless of signup casing", async () => {
    await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "mixed@example.com",
        username: "MiXeDcAsE",
        password: "password1234",
        name: "Mixed",
      })
      .expect(200);

    const db = getTestDb();
    const [row] = await db
      .select({ username: user.username })
      .from(user)
      .where(sql`lower(${user.username}) = 'mixedcase'`);
    expect(row).toBeDefined();
    expect(row.username).toBe("mixedcase");
  });
});

// Defense-in-depth — the LOWER(username) unique index catches any row that
// sidesteps the sign-up hook.
describe("REQ-005 LOWER(username) unique index rejects case-variant duplicates", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-005 direct INSERT of a case-variant username violates user_username_ci_uq", async () => {
    const db = getTestDb();
    await db.insert(user).values({
      id: "uname-1",
      name: "Uno",
      email: "uname-one@example.com",
      username: "nameuno",
    });

    await expect(
      db.insert(user).values({
        id: "uname-2",
        name: "Duo",
        email: "uname-two@example.com",
        username: "NameUno",
      }),
    ).rejects.toThrow();
  });
});
