// R13 (no separate DM history) + R14 (room_ban not applicable to DMs).
//
// R13: GET /api/v1/dms/:id/messages MUST NOT exist. DM history is
// served by GET /api/v1/rooms/:id/messages, same as any other room.
// A 404 here documents the design decision at test-level so a future
// refactor that adds a DM-specific history handler breaks CI.
//
// R14: REQ-090 room_ban does NOT apply to DM rooms. DB-level
// invariant asserted after we seed a handful of DMs: no row in
// room_ban has a roomId whose room.kind='dm'.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { friendship, room, roomBan, user } from "@ai-herders/shared/schema";

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

async function addFriendship(a: string, b: string): Promise<void> {
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await getTestDb()
    .insert(friendship)
    .values({ id: randomUUID(), userAId, userBId });
}

describe("REQ-062 R13 + REQ-090 R14 DM route surface", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-062 R13 GET /api/v1/dms/:id/messages is NOT a route → 404", async () => {
    const alice = await register(app, "rs-dm-a@example.com", "rs_dm_a");
    const bob = await register(app, "rs-dm-b@example.com", "rs_dm_b");
    await addFriendship(alice.userId, bob.userId);

    const createRes = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(createRes.status).toBe(201);
    const roomId = createRes.body.roomId as string;

    // The DM-specific history path MUST NOT exist. DM history is served
    // by /api/v1/rooms/:id/messages.
    const notFound = await alice.agent.get(
      `/api/v1/dms/${roomId}/messages`,
    );
    expect(notFound.status).toBe(404);

    // Sanity — the rooms-scoped history route DOES serve this DM.
    const ok = await alice.agent.get(`/api/v1/rooms/${roomId}/messages`);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.messages)).toBe(true);
  });

  test("REQ-090 R14 no room_ban row points at a DM room (DB invariant)", async () => {
    // Seed a couple of DM rooms so the assertion is non-vacuous.
    const alice = await register(app, "rs-ban-a@example.com", "rs_ban_a");
    const bob = await register(app, "rs-ban-b@example.com", "rs_ban_b");
    const carol = await register(app, "rs-ban-c@example.com", "rs_ban_c");
    await addFriendship(alice.userId, bob.userId);
    await addFriendship(alice.userId, carol.userId);
    await alice.agent.post("/api/v1/dms").send({ userId: bob.userId }).expect(201);
    await alice.agent.post("/api/v1/dms").send({ userId: carol.userId }).expect(201);

    // Direct SQL across room_ban × room — if any ban row references a
    // kind='dm' room, this fails.
    const offenders = await getTestDb()
      .select({ id: roomBan.id })
      .from(roomBan)
      .innerJoin(room, eq(roomBan.roomId, room.id))
      .where(eq(room.kind, "dm"));
    expect(offenders).toHaveLength(0);

    // Second assertion — the aggregate COUNT(*) form spec §4 R14 names
    // verbatim. Kept as a second expect so the failure message is
    // readable either way.
    const [agg] = await getTestDb()
      .select({ c: sql<number>`count(*)::int` })
      .from(roomBan)
      .innerJoin(room, eq(roomBan.roomId, room.id))
      .where(eq(room.kind, "dm"));
    expect(agg!.c).toBe(0);
  });
});
