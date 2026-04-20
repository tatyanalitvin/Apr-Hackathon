import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// Auto-enroll new users into the seeded 'general' room on signup.
//
// NOT a v4 REQ — v4 REQ-022 is "Room description" (unimplemented; tracked in
// FOLLOWUPS.md). This test covers a permanent non-v4 UX convenience claimed
// in s2-rooms.md §7 (non-v4 deviations) and ADR-0006. Kept indefinitely per
// s2-rooms.md R1 `[x]` (commit ee0b136).
//
// Driver: apps/backend/src/lib/message-auth.ts:44-47 rejects posts to
// /api/v1/rooms/:id/messages with 403 when the caller is not a room_member.
// A brand-new signup has no memberships, so without this hook the very first
// message would 403. The hook in auth.ts inserts a room_member row for
// (newUser.id, 'general') inside better-auth's databaseHooks.user.create.after,
// so the auto-enroll happens for BOTH sign-up surfaces (HTTP POST and
// internal auth.api.signUpEmail from scripts/seed.ts).

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

const GENERAL = "general";

async function seedGeneralRoom(): Promise<void> {
  const db = getTestDb();
  // No ownerId — rooms.ownerId is `onDelete: "set null"`-nullable in schema.ts,
  // and picking an owner here would force an extra user insertion that the
  // hook under test would then enroll as a side-effect.
  await db.insert(room).values({
    id: GENERAL,
    name: GENERAL,
    kind: "group",
    visibility: "public",
    ownerId: null,
  });
  await db.insert(messageSeq).values({ roomId: GENERAL, seq: 0n });
}

async function userIdByEmail(email: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return row.id;
}

describe("auto-enroll new users in 'general' on sign-up (non-v4 convenience, see ADR-0006)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("sign-up inserts a room_member row for (newUser, 'general')", async () => {
    await seedGeneralRoom();

    const agent = request.agent(app.server);
    await agent
      .post("/api/auth/sign-up/email")
      .send({
        email: "enroll-one@example.com",
        username: "enroll_one",
        password: TEST_PASSWORD_OK,
        name: "Enroll One",
      })
      .expect(200);

    const newUserId = await userIdByEmail("enroll-one@example.com");
    const memberships = await getTestDb()
      .select({ id: roomMember.id })
      .from(roomMember)
      .where(
        and(
          eq(roomMember.userId, newUserId),
          eq(roomMember.roomId, GENERAL),
        ),
      );
    expect(memberships).toHaveLength(1);
  });

  test("fresh signup can POST to /api/v1/rooms/general/messages (not 403)", async () => {
    await seedGeneralRoom();

    const agent = request.agent(app.server);
    await agent
      .post("/api/auth/sign-up/email")
      .send({
        email: "enroll-two@example.com",
        username: "enroll_two",
        password: TEST_PASSWORD_OK,
        name: "Enroll Two",
      })
      .expect(200);

    const res = await agent
      .post(`/api/v1/rooms/${GENERAL}/messages`)
      .send({ body: "first post from a fresh signup" });

    // message-auth.ts:44-47 would return 403 without the enrollment; the
    // route returns 201 on happy-path send (see routes/messages.ts +
    // messages-send.test.ts). This is the demo-gate assertion — 403 here
    // means the hotfix regressed.
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      roomId: GENERAL,
      body: "first post from a fresh signup",
    });

    // Cleanup assertion: the seq counter advanced, i.e. the allocator ran.
    const [seqRow] = await getTestDb()
      .select({ seq: messageSeq.seq })
      .from(messageSeq)
      .where(eq(messageSeq.roomId, GENERAL));
    expect(seqRow?.seq).toBe(1n);

    const rows = await getTestDb()
      .select({ id: message.id })
      .from(message)
      .where(eq(message.roomId, GENERAL));
    expect(rows).toHaveLength(1);
  });

  test("sign-up succeeds silently when 'general' room is not seeded", async () => {
    // No seedGeneralRoom() call — simulates a dev DB where `pnpm db:seed`
    // hasn't run yet. The hook logs a warning and returns; sign-up must not
    // fail. This fences the "skip silently, do not throw" contract so a
    // future change that tightens the hook (e.g. throws instead of warns)
    // can't take the signup path down with it.
    const res = await request(app.server)
      .post("/api/auth/sign-up/email")
      .send({
        email: "enroll-noroom@example.com",
        username: "enroll_noroom",
        password: TEST_PASSWORD_OK,
        name: "Enroll NoRoom",
      });

    expect(res.status).toBe(200);

    // The user row is written; just no membership row exists.
    const newUserId = await userIdByEmail("enroll-noroom@example.com");
    const memberships = await getTestDb()
      .select({ id: roomMember.id })
      .from(roomMember)
      .where(eq(roomMember.userId, newUserId));
    expect(memberships).toHaveLength(0);
  });
});
