import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-018 — tombstone rename must NOT leak into historical messages.
// `message.authorUsername` is snapshotted at send time (schema.ts:256) so
// when account-delete rewrites `user.username` to the tombstone string,
// already-sent messages keep rendering with the original username.
// The DELETED_USER_DISPLAY substitution is applied at serialization via
// lib/users.ts#formatUserDisplay (covered in account-deleted-user-display),
// but the raw DB snapshot must remain untouched — otherwise a future
// change to the substitution logic would permanently lose the original
// author identity.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  message,
  messageSeq,
  room,
  user,
} from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

const GENERAL = "general";

async function seedGeneralRoom(): Promise<void> {
  const db = getTestDb();
  await db.insert(room).values({
    id: GENERAL,
    name: GENERAL,
    kind: "group",
    visibility: "public",
    ownerId: null,
  });
  await db.insert(messageSeq).values({ roomId: GENERAL, seq: 0n });
}

async function signUp(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<{ agent: request.Agent; userId: string }> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email.toLowerCase()))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return { agent, userId: row.id };
}

describe("REQ-018 account delete preserves message.authorUsername snapshot", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Truncation in tests/setup.ts wipes rooms too; reseed #general so
    // auto-enroll on sign-up has a target and the subsequent message post
    // isn't 403-blocked by the message-auth membership gate.
    await seedGeneralRoom();
  });

  test("REQ-018 authored messages keep the pre-delete username in the DB", async () => {
    const original = "snap_author";
    const { agent, userId } = await signUp(app, "snap-author@example.com", original);

    // Send a message into the auto-enrolled #general room so authorUsername
    // is written with the original value.
    const send = await agent
      .post("/api/v1/rooms/general/messages")
      .send({ body: "hello from snap_author" });
    expect(send.status).toBe(201);

    // Fire the delete — tombstone rewrites user.username, but the message
    // row's authorUsername is a snapshot and must not change.
    const del = await agent
      .delete("/api/v1/users/me")
      .send({ password: TEST_PASSWORD_OK });
    expect(del.status).toBe(204);

    const [u] = await getTestDb()
      .select({ username: user.username, deletedAt: user.deletedAt })
      .from(user)
      .where(eq(user.id, userId));
    expect(u.deletedAt).not.toBeNull();
    expect(u.username).not.toBe(original);
    expect(u.username).toMatch(/^deleted-/);

    const msgRows = await getTestDb()
      .select({ authorUsername: message.authorUsername })
      .from(message)
      .where(eq(message.authorId, userId));
    expect(msgRows.length).toBeGreaterThan(0);
    for (const row of msgRows) {
      expect(row.authorUsername).toBe(original);
    }
  });
});
