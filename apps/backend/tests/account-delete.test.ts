// Task #7 (v3.docx §2.1.5) — POST /api/auth/delete-user.
//
// Method is POST, not DELETE. Verified by source-read of
// node_modules/better-auth/dist/api/routes/update-user.mjs:215
// (`createAuthEndpoint("/delete-user", { method: "POST", ... })`). Context7
// docs show DELETE; they are wrong for 1.6.5. See §10 "task #7 — method"
// entry for why this wasn't just "trust the docs".
//
// better-auth 1.6.5 ships a native delete-user endpoint; we only flip
// `user.deleteUser.enabled = true` in auth.ts. The endpoint is reached
// through our existing /api/auth/* catch-all proxy (ADR-0004), so there is
// no app-owned route for this feature — but the behavioural contract is
// ours to own via tests.
//
// Coverage (matches R18 in docs/specs/s1-auth.md):
//   - unauthenticated → 401 (or similar 4xx; the proxy rejects missing creds)
//   - wrong password → 4xx (better-auth's password-reconfirm guard fires)
//   - happy path → 200; cookie no longer auths against /api/v1/sessions;
//     DB `user` row is gone, `session` rows FK-cascade away.
//
// Why password reconfirm: irreversible op, standard practice, not forbidden
// by v3.docx. better-auth supports `{ password }` in the delete body (see
// §10 "before task #7" entry for why we chose this over a token-verify
// flow).
//
// Explicitly deferred to S2 (TODO(S2-rooms)): the v3 §2.1.5 room-level
// cascade ("owner's rooms + messages + files deleted"). Rooms don't exist
// in S1, so there is nothing to assert beyond the auth-surface cascade.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { session, user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

const seed = {
  email: "delete-anna@example.com",
  username: "delete_anna",
  password: "password1234",
  name: "Delete Anna",
};

describe("v3.docx §2.1.5 DELETE /api/auth/delete-user (task #7)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("v3 §2.1.5 unauthenticated delete → 4xx, no rows touched", async () => {
    const res = await request(app.server)
      .post("/api/auth/delete-user")
      .send({ password: seed.password });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("v3 §2.1.5 wrong password → 4xx, user row still present", async () => {
    const agent = request.agent(app.server);
    await agent.post("/api/auth/sign-up/email").send(seed).expect(200);

    const res = await agent
      .post("/api/auth/delete-user")
      .send({ password: "not-the-password" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const db = getTestDb();
    const rows = await db.select().from(user).where(eq(user.email, seed.email));
    expect(rows).toHaveLength(1);
  });

  test("v3 §2.1.5 happy path → user + session rows gone, cookie stops auth'ing", async () => {
    const agent = request.agent(app.server);
    await agent.post("/api/auth/sign-up/email").send(seed).expect(200);

    // Sanity: logged in, session exists.
    const pre = await agent.get("/api/v1/sessions").expect(200);
    expect(pre.body).toHaveLength(1);
    const userId = (
      await getTestDb().select().from(user).where(eq(user.email, seed.email))
    )[0].id;

    const del = await agent
      .post("/api/auth/delete-user")
      .send({ password: seed.password });
    expect(del.status).toBe(200);

    // Cookie is now stale — DB cascade removed the session row.
    const after = await agent.get("/api/v1/sessions");
    expect(after.status).toBe(401);

    const db = getTestDb();
    const userRows = await db.select().from(user).where(eq(user.id, userId));
    expect(userRows).toHaveLength(0);
    const sessionRows = await db
      .select()
      .from(session)
      .where(eq(session.userId, userId));
    expect(sessionRows).toHaveLength(0);
  });
});
