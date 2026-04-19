// REQ-018 follow-up — after account deletion a new user must be able to
// register with the same email (and the same username). Without a tombstone
// rename the soft-deleted row keeps holding the email / username in the
// new LOWER() unique indexes (0010), and the second sign-up collides.
//
// Fix shape (implemented in apps/backend/src/routes/account.ts): inside the
// delete transaction, rewrite email = "deleted-${id}@tombstone.invalid" and
// username = "deleted-${id.slice(0, 8)}" on the soft-deleted row. The
// originals are then free for re-registration. message.authorUsername is a
// send-time snapshot (schema.ts:256) so historical messages keep rendering
// with the original username (substitution to DELETED_USER_DISPLAY happens
// at serialization via lib/users.ts#formatUserDisplay).

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

async function signUp(
  app: FastifyInstance,
  email: string,
  username: string,
  password = "password1234",
): Promise<request.Agent> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password, name: username })
    .expect(200);
  return agent;
}

describe("REQ-018 re-register after delete — tombstone frees email + username", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-018 deleted account's email is reusable by a fresh sign-up", async () => {
    const email = "rereg-email@example.com";
    const aAgent = await signUp(app, email, "rereg_alpha");

    const del = await aAgent
      .delete("/api/v1/users/me")
      .send({ password: "password1234" });
    expect(del.status).toBe(204);

    // Fresh sign-up with the same email — a different username so this test
    // isolates the email reusability axis.
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({ email, username: "rereg_alpha2", password: "password1234", name: "rereg_alpha2" });
    expect(res.status).toBe(200);

    // The original row is tombstoned, the new row holds the free email.
    const rows = await getTestDb()
      .select({ id: user.id, email: user.email, deletedAt: user.deletedAt })
      .from(user);
    const live = rows.find((r) => r.email === email);
    expect(live).toBeDefined();
    expect(live!.deletedAt).toBeNull();
    const tombstoned = rows.find((r) => r.deletedAt !== null);
    expect(tombstoned).toBeDefined();
    expect(tombstoned!.email).not.toBe(email);
    expect(tombstoned!.email).toMatch(/^deleted-.*@tombstone\.invalid$/);
  });

  test("REQ-018 deleted account's username is reusable by a fresh sign-up", async () => {
    const username = "rereg_user";
    const aAgent = await signUp(app, "rereg-u-a@example.com", username);

    const del = await aAgent
      .delete("/api/v1/users/me")
      .send({ password: "password1234" });
    expect(del.status).toBe(204);

    // Fresh sign-up with the same username, different email.
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "rereg-u-b@example.com",
        username,
        password: "password1234",
        name: username,
      });
    expect(res.status).toBe(200);

    const rows = await getTestDb()
      .select({ id: user.id, username: user.username, deletedAt: user.deletedAt })
      .from(user);
    const live = rows.find((r) => r.username === username);
    expect(live).toBeDefined();
    expect(live!.deletedAt).toBeNull();
    const tombstoned = rows.find((r) => r.deletedAt !== null);
    expect(tombstoned).toBeDefined();
    expect(tombstoned!.username).not.toBe(username);
    expect(tombstoned!.username).toMatch(/^deleted-/);
  });

  test("REQ-018 case-insensitive reuse — deleted 'Alice@x.com' frees 'alice@x.com'", async () => {
    const originalEmail = "CaseReuse@example.com";
    const aAgent = await signUp(app, originalEmail, "case_reuse_a");

    await aAgent
      .delete("/api/v1/users/me")
      .send({ password: "password1234" })
      .expect(204);

    // A lowercased variant must be free for re-registration (the LOWER()
    // unique index is what would otherwise collide).
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "casereuse@example.com",
        username: "case_reuse_b",
        password: "password1234",
        name: "case_reuse_b",
      });
    expect(res.status).toBe(200);
  });
});
