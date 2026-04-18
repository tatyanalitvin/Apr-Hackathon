import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";

// Integration coverage for the zod preHandlers on /api/auth/sign-up/email
// and /api/auth/sign-in/email (task #2b). The preHandlers must reject bad
// bodies with a stable 400 + zod-issue payload BEFORE the request reaches
// the better-auth bridge — so the client gets an actionable error and no
// DB work is attempted.

describe("REQ-008 zod boundary guard rejects short password (integration)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-008 POST /api/auth/sign-up/email → 400 with zod issue shape", async () => {
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "anna@example.com",
        username: "anna_01",
        password: "short",
        name: "Anna",
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "validation" });
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(
      res.body.issues.some(
        (i: { path: (string | number)[] }) => i.path.includes("password"),
      ),
    ).toBe(true);
  });
});

describe("REQ-009 zod boundary guard rejects malformed username (integration)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-009 POST /api/auth/sign-up/email with hyphenated username → 400", async () => {
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "anna@example.com",
        username: "bad-name",
        password: "password1234",
        name: "Anna",
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "validation" });
    expect(
      res.body.issues.some(
        (i: { path: (string | number)[] }) => i.path.includes("username"),
      ),
    ).toBe(true);
  });
});

describe("REQ-010 zod boundary guard on sign-in (integration)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-010 POST /api/auth/sign-in/email with empty password → 400", async () => {
    const res = await request(app.server)
      .post("/api/auth/sign-in/email")
      .send({ email: "anna@example.com", password: "" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "validation" });
  });
});
