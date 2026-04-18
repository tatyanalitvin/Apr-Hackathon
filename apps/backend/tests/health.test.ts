import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";

describe("rig: GET /health", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("returns {status: 'ok', service: 'backend'} with 200", async () => {
    const res = await request(app.server).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", service: "backend" });
  });
});
