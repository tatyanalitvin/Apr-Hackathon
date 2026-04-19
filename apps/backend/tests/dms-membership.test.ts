// REQ-063 R3 + REQ-064 R10 — DM membership shape asserted in its own
// file so `pnpm trace` sees a dedicated REQ-063 / REQ-064 test location
// rather than relying on the incidental assertions in dms-create.test.ts.
//
// R3: a DM MUST have exactly 2 roomMember rows.
// R10: ownerId IS NULL on the room + no row with role != 'member'.
// Invariant sweep: after all DMs are created, no row across the whole
// table violates R3/R10 for any kind='dm' room.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { friendship, room, roomMember, user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

async function register(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<{ agent: request.Agent; userId: string }> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: "password1234", name: username })
    .expect(200);
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return { agent, userId: row.id };
}

async function makeFriends(a: string, b: string): Promise<void> {
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await getTestDb()
    .insert(friendship)
    .values({ id: randomUUID(), userAId, userBId });
}

describe("REQ-063 R3 + REQ-064 R10 DM membership shape", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-063 R3 created DM has exactly 2 members", async () => {
    const alice = await register(
      app,
      "mem-dm-alice@example.com",
      "mem_dm_alice",
    );
    const bob = await register(app, "mem-dm-bob@example.com", "mem_dm_bob");
    await makeFriends(alice.userId, bob.userId);

    const res = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(res.status).toBe(201);
    const roomId = res.body.roomId as string;

    const members = await getTestDb()
      .select()
      .from(roomMember)
      .where(eq(roomMember.roomId, roomId));
    expect(members).toHaveLength(2);
    const memberIds = new Set(members.map((m) => m.userId));
    expect(memberIds.has(alice.userId)).toBe(true);
    expect(memberIds.has(bob.userId)).toBe(true);
  });

  test("REQ-064 R10 DM room has ownerId=NULL and all members role='member'", async () => {
    const alice = await register(
      app,
      "mem-dm-alice2@example.com",
      "mem_dm_alice2",
    );
    const bob = await register(
      app,
      "mem-dm-bob2@example.com",
      "mem_dm_bob2",
    );
    await makeFriends(alice.userId, bob.userId);

    const res = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(res.status).toBe(201);
    const roomId = res.body.roomId as string;

    const [roomRow] = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.id, roomId));
    expect(roomRow).toBeDefined();
    expect(roomRow!.ownerId).toBeNull();

    const members = await getTestDb()
      .select()
      .from(roomMember)
      .where(eq(roomMember.roomId, roomId));
    for (const m of members) {
      expect(m.role).toBe("member");
    }
  });

  test("REQ-063 + REQ-064 invariant — no DM room anywhere violates R3/R10", async () => {
    // This is the global safety net. Runs after the per-pair tests have
    // already created a handful of DMs in this describe block.
    const alice = await register(
      app,
      "mem-dm-alice3@example.com",
      "mem_dm_alice3",
    );
    const bob = await register(
      app,
      "mem-dm-bob3@example.com",
      "mem_dm_bob3",
    );
    const carol = await register(
      app,
      "mem-dm-carol3@example.com",
      "mem_dm_carol3",
    );
    await makeFriends(alice.userId, bob.userId);
    await makeFriends(alice.userId, carol.userId);

    await alice.agent.post("/api/v1/dms").send({ userId: bob.userId }).expect(201);
    await alice.agent.post("/api/v1/dms").send({ userId: carol.userId }).expect(201);

    const dmRooms = await getTestDb()
      .select({ id: room.id, ownerId: room.ownerId })
      .from(room)
      .where(eq(room.kind, "dm"));
    expect(dmRooms.length).toBeGreaterThanOrEqual(2);

    // R10: no DM room has ownerId set.
    const dmsWithOwner = await getTestDb()
      .select({ id: room.id })
      .from(room)
      .where(and(eq(room.kind, "dm"), isNotNull(room.ownerId)));
    expect(dmsWithOwner).toHaveLength(0);

    // R10: no DM room has any roomMember with role != 'member'.
    const dmRoomIds = dmRooms.map((r) => r.id);
    const badRoles = await getTestDb()
      .select({ id: roomMember.id })
      .from(roomMember)
      .where(
        and(
          inArray(roomMember.roomId, dmRoomIds),
          ne(roomMember.role, "member"),
        ),
      );
    expect(badRoles).toHaveLength(0);

    // R3: every DM room has exactly 2 members.
    const counts = await getTestDb()
      .select({
        roomId: roomMember.roomId,
        c: sql<number>`count(*)::int`,
      })
      .from(roomMember)
      .where(inArray(roomMember.roomId, dmRoomIds))
      .groupBy(roomMember.roomId);
    for (const row of counts) {
      expect(row.c).toBe(2);
    }
    expect(counts).toHaveLength(dmRoomIds.length);
  });
});
