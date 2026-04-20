import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-158 — GET /api/v1/admin/metrics auth gate + shape.
//
// The admin dashboard must be gated on the ADMIN_USER_IDS env CSV
// (see S3_ADMIN_AGENT_BRIEF.md §3). Non-admin signed-in users get 403 —
// not 401, because they ARE authenticated, just not authorized. Logged-out
// callers get 401, same as every other /api/v1/* route.
//
// Snapshot shape is locked by AdminMetricsSnapshot in shared/protocol.ts;
// this file exercises every field.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import {
  __resetMetricsForTests,
  recordHttpError,
  recordMessageSent,
  recordSecurityEvent,
} from "../src/lib/metrics";
import { getTestDb } from "./db-helpers";

async function userIdByEmail(email: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return row.id;
}

async function signUpCookie(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<{ cookie: string; userId: string }> {
  const res = await request(app.server)
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  return { cookie, userId: await userIdByEmail(email) };
}

describe("REQ-158 admin · GET /api/v1/admin/metrics auth gate", () => {
  let app: FastifyInstance;
  const originalAdminIds = process.env.ADMIN_USER_IDS;

  beforeAll(async () => {
    // Seed the allow-list BEFORE buildApp() so the env.ts singleton reads
    // it. We reset ADMIN_USER_IDS to a userId we create below; until then
    // it's empty, so the "no one is admin" default branch is exercised.
    process.env.ADMIN_USER_IDS = "";
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (originalAdminIds === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = originalAdminIds;
  });

  beforeEach(() => {
    __resetMetricsForTests();
  });

  test("401 when no session", async () => {
    await request(app.server).get("/api/v1/admin/metrics").expect(401);
  });

  test("403 when signed in but not in ADMIN_USER_IDS", async () => {
    const bob = await signUpCookie(app, "admin-bob@example.com", "adm_bob");
    void bob;
    await request(app.server)
      .get("/api/v1/admin/metrics")
      .set("cookie", bob.cookie)
      .expect(403);
  });

  test("200 for an allow-listed user; snapshot shape locked", async () => {
    const alice = await signUpCookie(app, "admin-alice@example.com", "adm_alice");

    // Mutate the env var AT REQUEST TIME — the route handler re-reads it
    // each call so the hackathon operator can rotate admins without a
    // restart. The env schema parses once at module load, so we poke the
    // raw process.env.
    process.env.ADMIN_USER_IDS = alice.userId;

    // Seed each widget with a distinct non-zero value so a drift between
    // the snapshot and the protocol shape lights up here first.
    recordMessageSent();
    recordMessageSent();
    recordHttpError(500);
    recordSecurityEvent({ type: "csrf_fail", ip: "127.0.0.1", route: "POST /api/v1/dms" });

    const res = await request(app.server)
      .get("/api/v1/admin/metrics")
      .set("cookie", alice.cookie)
      .expect(200);

    expect(typeof res.body.generatedAt).toBe("string");
    expect(() => new Date(res.body.generatedAt).toISOString()).not.toThrow();
    expect(typeof res.body.onlineUsers).toBe("number");
    expect(res.body.messagesPerMinute).toBe(2);
    expect(res.body.messagesPerMinuteSeries).toHaveLength(12);
    expect(res.body.errorCount5min).toBe(1);
    expect(res.body.recentSecurityEvents).toHaveLength(1);
    expect(res.body.recentSecurityEvents[0].type).toBe("csrf_fail");
    expect(res.body.recentSecurityEvents[0].route).toBe("POST /api/v1/dms");
    // IP must be redacted (8-hex). Raw "127.0.0.1" must never appear.
    expect(res.body.recentSecurityEvents[0].ip).toMatch(/^[0-9a-f]{8}$/);
    expect(res.body.recentSecurityEvents[0].ip).not.toBe("127.0.0.1");
  });

  test("multi-admin CSV is parsed; whitespace tolerated", async () => {
    const charlie = await signUpCookie(app, "admin-charlie@example.com", "adm_c");
    const dana = await signUpCookie(app, "admin-dana@example.com", "adm_d");

    process.env.ADMIN_USER_IDS = ` ${charlie.userId} , ${dana.userId} `;

    await request(app.server)
      .get("/api/v1/admin/metrics")
      .set("cookie", charlie.cookie)
      .expect(200);
    await request(app.server)
      .get("/api/v1/admin/metrics")
      .set("cookie", dana.cookie)
      .expect(200);
  });
});
