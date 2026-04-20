// REQ-028 — per-room 1,000-member cap on POST /api/v1/rooms/:id/join.
// Binding spec: v3.docx §3.1 ("up to 1000 per room"), docs/specs/s2-rooms.md R5.
//
// Handler branch under test lives in apps/backend/src/routes/rooms.ts lines
// 171-192. The cap fires with 409 { error: "room_full", cap: 1000 } when a
// non-member's join would grow the room past ROOM_MEMBER_CAP. Already-members
// are excluded from the count check so the idempotent ON CONFLICT DO NOTHING
// path still returns 200 { joined: false } regardless of room size.
//
// Seeding strategy: 1,000 user rows + 1,000 room_member rows inserted directly
// via Drizzle (one bulk insert per table). Avoids the sign-up HTTP path so
// the REQ-009 /24-subnet rate-limit bucket stays untouched (see memory:
// feedback-signup-rate-limit-flush) and the test lands in seconds, not
// minutes. The 1,001st user uses the real sign-up route because it needs a
// live better-auth session cookie to hit the join handler.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { room, roomMember, user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { ROOM_MEMBER_CAP } from "../src/routes/rooms";
import { getTestDb } from "./db-helpers";
import { TEST_PASSWORD_OK } from "./helpers/fixtures";

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
): Promise<SignedUpAgent> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

// Build a public group room prepopulated with N existing members. Room +
// users + room_member rows are landed in a single transaction so (a) the FK
// targets are guaranteed visible to downstream inserts on the same pinned
// connection, and (b) the whole fixture commits atomically rather than
// leaving the suite with half-seeded state if a chunk bounces. CHUNK=500
// keeps pg's 65535-param-per-statement ceiling comfortably out of reach
// (5 cols × 500 rows = 2500 params).
async function seedRoomWithMembers(
  name: string,
  n: number,
  tag: string,
): Promise<string> {
  const roomId = randomUUID();
  const CHUNK = 500;
  const users = Array.from({ length: n }, (_, i) => ({
    id: `u-${tag}-${i}`,
    name: `Cap ${tag} ${i}`,
    email: `cap-${tag}-${i}@example.com`,
    username: `cap_${tag}_${i}`,
  }));
  const members = users.map((u) => ({
    id: `m-${tag}-${u.id}`,
    userId: u.id,
    roomId,
    joinedAt: new Date(),
  }));

  await getTestDb().transaction(async (tx) => {
    await tx.insert(room).values({
      id: roomId,
      name,
      kind: "group",
      visibility: "public",
    });
    for (let i = 0; i < users.length; i += CHUNK) {
      await tx.insert(user).values(users.slice(i, i + CHUNK));
    }
    for (let i = 0; i < members.length; i += CHUNK) {
      await tx.insert(roomMember).values(members.slice(i, i + CHUNK));
    }
  });
  return roomId;
}

async function memberCount(roomId: string): Promise<number> {
  const [row] = await getTestDb()
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(roomMember)
    .where(eq(roomMember.roomId, roomId));
  return row?.count ?? 0;
}

describe("REQ-028 per-room 1,000-member cap (POST /rooms/:id/join)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // Boundary proof #1: the 1000th join still succeeds. If the handler were
  // off-by-one (`> CAP` vs `>= CAP` mistakes), this test would 409 one step
  // too early. 999 members pre-seeded + 1 real HTTP joiner → count hits
  // exactly CAP.
  test(`REQ-028 ${ROOM_MEMBER_CAP}th join (at cap boundary) succeeds`, async () => {
    const roomId = await seedRoomWithMembers(
      "r028-boundary",
      ROOM_MEMBER_CAP - 1,
      "boundary",
    );
    expect(await memberCount(roomId)).toBe(ROOM_MEMBER_CAP - 1);

    const joiner = await registerAgent(
      app,
      "r028-boundary@example.com",
      "r028_boundary",
    );
    const res = await joiner.agent.post(`/api/v1/rooms/${roomId}/join`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ joined: true });

    expect(await memberCount(roomId)).toBe(ROOM_MEMBER_CAP);

    const rows = await getTestDb()
      .select({ id: roomMember.id })
      .from(roomMember)
      .where(
        and(eq(roomMember.userId, joiner.userId), eq(roomMember.roomId, roomId)),
      );
    expect(rows).toHaveLength(1);
  });

  // Boundary proof #2: the 1001st join is rejected. 1000 members pre-seeded;
  // an unrelated, not-yet-a-member user attempts to join and must hit the
  // 409 room_full branch. Membership row MUST NOT be written.
  test(`REQ-028 ${ROOM_MEMBER_CAP + 1}th join returns 409 room_full`, async () => {
    const roomId = await seedRoomWithMembers(
      "r028-over-cap",
      ROOM_MEMBER_CAP,
      "over",
    );
    expect(await memberCount(roomId)).toBe(ROOM_MEMBER_CAP);

    const joiner = await registerAgent(
      app,
      "r028-over@example.com",
      "r028_over",
    );
    const res = await joiner.agent.post(`/api/v1/rooms/${roomId}/join`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "room_full",
      cap: ROOM_MEMBER_CAP,
    });

    // Count unchanged — rejection must not write a membership row.
    expect(await memberCount(roomId)).toBe(ROOM_MEMBER_CAP);

    const rows = await getTestDb()
      .select({ id: roomMember.id })
      .from(roomMember)
      .where(
        and(eq(roomMember.userId, joiner.userId), eq(roomMember.roomId, roomId)),
      );
    expect(rows).toHaveLength(0);
  });

  // Idempotent repeat guard: a room at cap must still accept repeat joins
  // from existing members (the handler skips the cap check for already-
  // members so ON CONFLICT DO NOTHING can return 200 {joined:false}).
  // Without this test, a future refactor that moved the count check before
  // the existing-member lookup would silently break clients that retry.
  test(`REQ-028 existing member at cap — repeat join returns 200 joined=false`, async () => {
    const roomId = await seedRoomWithMembers(
      "r028-repeat-at-cap",
      ROOM_MEMBER_CAP,
      "repeat",
    );
    expect(await memberCount(roomId)).toBe(ROOM_MEMBER_CAP);

    // Sign up a real user (needed for a live session cookie) and splice
    // their id into one of the seeded memberships so they're a member of a
    // room that's sitting right at cap. Net count stays at ROOM_MEMBER_CAP.
    const repeater = await registerAgent(
      app,
      "r028-repeat@example.com",
      "r028_repeat",
    );
    await getTestDb().transaction(async (tx) => {
      await tx
        .delete(roomMember)
        .where(
          and(
            eq(roomMember.userId, `u-repeat-0`),
            eq(roomMember.roomId, roomId),
          ),
        );
      await tx.insert(roomMember).values({
        id: `m-repeat-real`,
        userId: repeater.userId,
        roomId,
        joinedAt: new Date(),
      });
    });
    expect(await memberCount(roomId)).toBe(ROOM_MEMBER_CAP);

    const res = await repeater.agent.post(`/api/v1/rooms/${roomId}/join`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ joined: false });

    // Membership row count unchanged.
    expect(await memberCount(roomId)).toBe(ROOM_MEMBER_CAP);
  });
});
