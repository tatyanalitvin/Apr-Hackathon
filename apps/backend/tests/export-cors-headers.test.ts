// REQ-126 / REQ-127 — the export endpoint stamps
//   Content-Disposition: attachment; filename="user-data-export-<username>-<ts>.json"
// but on a cross-origin fetch browsers HIDE that header from JS unless the
// server lists it in Access-Control-Expose-Headers. Without this listing
// the web layer's download helper falls back to a less-descriptive
// client-generated filename (FOLLOWUPS.md "Export download uses client-
// generated filename").
//
// The fix is a one-liner on the @fastify/cors registration in app.ts:
// `exposedHeaders: ["content-disposition"]`. This test drives that: it
// fires a real CORS preflight-style request (Origin set to WEB_ORIGIN) and
// asserts the response carries the expose header on the response.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";
import { env } from "../src/env";

describe("REQ-126/127 CORS exposed-headers includes content-disposition", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-126 response carries access-control-expose-headers: content-disposition on CORS request", async () => {
    // An actual cross-origin request — hitting /health so we don't need auth
    // or a seeded DB state; the CORS plugin runs before every route.
    const res = await request(app.server)
      .get("/health")
      .set("Origin", env.WEB_ORIGIN);
    expect(res.status).toBe(200);
    const exposed = res.headers["access-control-expose-headers"];
    expect(exposed).toBeDefined();
    expect(String(exposed).toLowerCase()).toContain("content-disposition");
  });
});
