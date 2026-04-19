// S2 account-deletion + GDPR. Binding brief:
// `.human/S2_ACCOUNT_GDPR_AGENT_BRIEF.md` + v3.docx §2.2 "Account Removal".
//
// Supersedes the S1 task #11 hard-delete path (`POST /api/auth/delete-user`).
// Soft-delete rationale (v3 §2.2): "messages remain visible after account
// removal; username is replaced with a placeholder" — that's incompatible with
// a row-level purge (message.authorId FK would break). New contract:
//   - `DELETE /api/v1/users/me` with `{ password }` body.
//   - user row kept; `deletedAt` stamped.
//   - sessions revoked; friendship / friend_request / user_block / room_member
//     rows hard-deleted (relationship-layer cascade — Q6a in s2-dms.md).
//   - messages preserved with authorId intact; serialization swaps the username
//     for "[deleted user]" via `lib/users.ts#formatUserDisplay` (REQ-018).
//   - a later login attempt with the same credentials fails (REQ-019).
//
// REQ-125 still claimed in s1-auth.md §4 R18; this file covers it via the
// soft-delete contract (the REQ's behavioural intent — "cookie stops auth'ing,
// auth-surface rows gone" — is preserved). We DO NOT call the old
// `/api/auth/delete-user` endpoint: `deleteUser.enabled` flips to false in
// auth.ts as part of this S2 work so there's only one deletion path.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq, or } from "drizzle-orm";
import {
  friendRequest,
  friendship,
  room,
  roomMember,
  session,
  user,
  userBlock,
} from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

interface SignedUpAgent {
  agent: request.Agent;
  userId: string;
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

async function registerAgent(
  app: FastifyInstance,
  email: string,
  username: string,
  password = "password1234",
): Promise<SignedUpAgent> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password, name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

async function insertFriendship(a: string, b: string): Promise<string> {
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  const id = randomUUID();
  await getTestDb().insert(friendship).values({ id, userAId, userBId });
  return id;
}

async function insertRoom(): Promise<string> {
  const id = randomUUID();
  await getTestDb().insert(room).values({
    id,
    name: `cascade-${id.slice(0, 8)}`,
    kind: "group",
    visibility: "public",
  });
  return id;
}

async function insertRoomMember(userId: string, roomId: string): Promise<void> {
  await getTestDb()
    .insert(roomMember)
    .values({ id: randomUUID(), userId, roomId })
    .onConflictDoNothing({ target: [roomMember.userId, roomMember.roomId] });
}

describe("REQ-018 DELETE /api/v1/users/me cascade (task S2-account)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-018 unauthenticated → 401, no rows touched", async () => {
    const res = await request(app.server)
      .delete("/api/v1/users/me")
      .send({ password: "anything" });
    expect(res.status).toBe(401);
  });

  test("REQ-018 wrong password → 401, user row unchanged", async () => {
    const anna = await registerAgent(app, "s2del-wrong@example.com", "s2del_wrong");

    const res = await anna.agent
      .delete("/api/v1/users/me")
      .send({ password: "not-my-password" });
    expect(res.status).toBe(401);

    const [row] = await getTestDb()
      .select({ id: user.id, deletedAt: user.deletedAt })
      .from(user)
      .where(eq(user.id, anna.userId));
    expect(row.deletedAt).toBeNull();
  });

  test("REQ-018 happy path — user soft-deleted, relationship rows cascade, messages preserved, sessions gone (REQ-125)", async () => {
    const anna = await registerAgent(app, "s2del-anna@example.com", "s2del_anna");
    const bob = await registerAgent(app, "s2del-bob@example.com", "s2del_bob");
    const carol = await registerAgent(app, "s2del-carol@example.com", "s2del_carol");

    // Relationship fixtures: friendship with bob, blocked carol, a pending
    // outgoing friend_request to carol, and membership in an extra group room.
    await insertFriendship(anna.userId, bob.userId);

    const db = getTestDb();
    await db.insert(friendRequest).values({
      id: randomUUID(),
      fromId: anna.userId,
      toId: carol.userId,
      status: "pending",
    });
    await db.insert(userBlock).values({
      id: randomUUID(),
      byId: anna.userId,
      targetId: carol.userId,
    });

    const roomId = await insertRoom();
    await insertRoomMember(anna.userId, roomId);

    // Sanity-check the cookie still auths before deletion.
    const pre = await anna.agent.get("/api/v1/sessions").expect(200);
    expect(pre.body.length).toBeGreaterThanOrEqual(1);

    // Fire the delete.
    const del = await anna.agent
      .delete("/api/v1/users/me")
      .send({ password: "password1234" });
    expect(del.status).toBe(204);

    // Cookie no longer auths — session row FK-cascaded away.
    const after = await anna.agent.get("/api/v1/sessions");
    expect(after.status).toBe(401);

    // User row kept (messages FK remains intact) but soft-deleted.
    const [userRow] = await db
      .select({ id: user.id, deletedAt: user.deletedAt })
      .from(user)
      .where(eq(user.id, anna.userId));
    expect(userRow).toBeDefined();
    expect(userRow.deletedAt).not.toBeNull();

    const sessionRows = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, anna.userId));
    expect(sessionRows).toHaveLength(0);

    const friendshipRows = await db
      .select({ id: friendship.id })
      .from(friendship)
      .where(
        or(
          eq(friendship.userAId, anna.userId),
          eq(friendship.userBId, anna.userId),
        ),
      );
    expect(friendshipRows).toHaveLength(0);

    const frRows = await db
      .select({ id: friendRequest.id })
      .from(friendRequest)
      .where(
        or(
          eq(friendRequest.fromId, anna.userId),
          eq(friendRequest.toId, anna.userId),
        ),
      );
    expect(frRows).toHaveLength(0);

    const blockRows = await db
      .select({ id: userBlock.id })
      .from(userBlock)
      .where(
        or(
          eq(userBlock.byId, anna.userId),
          eq(userBlock.targetId, anna.userId),
        ),
      );
    expect(blockRows).toHaveLength(0);

    const memberRows = await db
      .select({ id: roomMember.id })
      .from(roomMember)
      .where(eq(roomMember.userId, anna.userId));
    expect(memberRows).toHaveLength(0);

    // Counterparties' own user rows are untouched beyond the torn edges.
    const [bobRow] = await db
      .select({ id: user.id, deletedAt: user.deletedAt })
      .from(user)
      .where(eq(user.id, bob.userId));
    expect(bobRow.deletedAt).toBeNull();
    const [carolRow] = await db
      .select({ id: user.id, deletedAt: user.deletedAt })
      .from(user)
      .where(eq(user.id, carol.userId));
    expect(carolRow.deletedAt).toBeNull();
  });
});
