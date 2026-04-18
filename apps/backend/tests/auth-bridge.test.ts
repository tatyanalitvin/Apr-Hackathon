import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";

describe("auth bridge (task #1)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("GET /api/auth/get-session returns 200 + null body when unauthenticated", async () => {
    const res = await request(app.server).get("/api/auth/get-session");
    expect(res.status).toBe(200);
    // better-auth returns `null` (literal) when there's no session cookie
    expect(res.body === null || Object.keys(res.body).length === 0).toBe(true);
  });

  test("auth routes are mounted under /api/auth/* (sign-in exists)", async () => {
    // POST with no body should not 404 — better-auth owns the path and
    // will reject with a validation / auth error instead.
    const res = await request(app.server)
      .post("/api/auth/sign-in/email")
      .send({});
    expect(res.status).not.toBe(404);
  });
});
