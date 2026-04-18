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
