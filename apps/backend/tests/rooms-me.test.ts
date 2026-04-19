// R4 — GET /api/v1/rooms/me.
// Non-v4 per ADR-0006 (see docs/specs/s2-rooms.md §7): no v4 REQ covers a
// "rooms-I-belong-to" endpoint; closest is the v4 room data-model REQ (see
// ADR-0006 §7 deviations). This exists because RoomList.tsx needs a per-user
// rooms list (DMs + group rooms incl. general) and filtering a catalog by
// membership client-side doesn't scale.
//
// Returns { rooms: [{ id, name, kind, visibility, lastReadSeq, roomHeadSeq }] }
// for every room where the caller has a room_member row. Includes DMs AND
// private group rooms (unlike R3). bigints serialize as strings on the wire
// (ADR-0003). Ordering: most-recent-activity DESC (MAX(message.created_at))
// with NULLS LAST so fresh rooms without messages still surface.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { message, messageSeq, room, roomMember, user } from "@ai-herders/shared/schema";

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
): Promise<SignedUpAgent> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: "password1234", name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

async function insertRoom(
  name: string | null,
  kind: "group" | "dm",
  visibility: "public" | "private",
): Promise<string> {
  const id = randomUUID();
  await getTestDb().insert(room).values({ id, name, kind, visibility });
  return id;
}

async function addMember(
  roomId: string,
  userId: string,
  lastReadSeq = 0n,
): Promise<void> {
  await getTestDb()
    .insert(roomMember)
    .values({ id: randomUUID(), roomId, userId, lastReadSeq });
}

async function insertMessage(
  roomId: string,
  authorId: string,
  authorUsername: string,
  seq: bigint,
  createdAt: Date,
): Promise<void> {
  const db = getTestDb();
  await db
    .insert(messageSeq)
    .values({ roomId, seq })
    .onConflictDoUpdate({ target: messageSeq.roomId, set: { seq } });
  await db.insert(message).values({
    id: randomUUID(),
    roomId,
    authorId,
    authorUsername,
    authorName: authorUsername,
    seq,
    body: "hello",
    createdAt,
  });
}

describe("GET /api/v1/rooms/me — caller memberships", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("no cookie → 401 unauthorized", async () => {
    const res = await request(app.server).get("/api/v1/rooms/me");
    expect(res.status).toBe(401);
  });

  test("returns only the caller's memberships across DMs + group rooms", async () => {
    const alice = await registerAgent(app, "r4-a@example.com", "r4_a");
    const bob = await registerAgent(app, "r4-a2@example.com", "r4_a2");
    const mineGroup = await insertRoom("r4-group-mine", "group", "public");
    const mineDm = await insertRoom(null, "dm", "private");
    const minePriv = await insertRoom("r4-group-priv", "group", "private");
    const theirGroup = await insertRoom("r4-group-theirs", "group", "public");
    await addMember(mineGroup, alice.userId);
    await addMember(mineDm, alice.userId);
    await addMember(minePriv, alice.userId);
    await addMember(theirGroup, bob.userId);

    const res = await alice.agent.get("/api/v1/rooms/me");
    expect(res.status).toBe(200);
    const ids = new Set(
      (res.body.rooms as Array<{ id: string }>).map((r) => r.id),
    );
    expect(ids).toEqual(new Set([mineGroup, mineDm, minePriv]));
    expect(ids.has(theirGroup)).toBe(false);
  });

  test("response shape — each row has id, name, kind, visibility, lastReadSeq (string), roomHeadSeq (string)", async () => {
    const alice = await registerAgent(app, "r4-b@example.com", "r4_b");
    const roomId = await insertRoom("r4-shape", "group", "public");
    await addMember(roomId, alice.userId, 5n);
    await insertMessage(roomId, alice.userId, "r4_b", 7n, new Date());

    const res = await alice.agent.get("/api/v1/rooms/me");
    expect(res.status).toBe(200);
    const [row] = (res.body.rooms as Array<Record<string, unknown>>).filter(
      (r) => r.id === roomId,
    );
    expect(row).toMatchObject({
      name: "r4-shape",
      kind: "group",
      visibility: "public",
      lastReadSeq: "5",
      roomHeadSeq: "7",
    });
  });

  test("roomHeadSeq defaults to \"0\" for rooms with no messages yet", async () => {
    const alice = await registerAgent(app, "r4-c@example.com", "r4_c");
    const roomId = await insertRoom("r4-empty", "group", "public");
    await addMember(roomId, alice.userId);

    const res = await alice.agent.get("/api/v1/rooms/me");
    expect(res.status).toBe(200);
    const row = (res.body.rooms as Array<{ id: string; roomHeadSeq: string }>).find(
      (r) => r.id === roomId,
    );
    expect(row?.roomHeadSeq).toBe("0");
  });

  test("ordering — most-recent-activity DESC; rooms with no messages sort last (NULLS LAST)", async () => {
    const alice = await registerAgent(app, "r4-d@example.com", "r4_d");
    const newest = await insertRoom("r4-newest", "group", "public");
    const middle = await insertRoom("r4-middle", "group", "public");
    const oldest = await insertRoom("r4-oldest", "group", "public");
    const quiet = await insertRoom("r4-quiet", "group", "public");
    await addMember(newest, alice.userId);
    await addMember(middle, alice.userId);
    await addMember(oldest, alice.userId);
    await addMember(quiet, alice.userId);

    const now = Date.now();
    // Deliberately insert in non-chronological order to confirm the
    // handler sorts by timestamp and not by insertion order.
    await insertMessage(oldest, alice.userId, "r4_d", 1n, new Date(now - 10_000));
    await insertMessage(newest, alice.userId, "r4_d", 2n, new Date(now));
    await insertMessage(middle, alice.userId, "r4_d", 3n, new Date(now - 5_000));

    const res = await alice.agent.get("/api/v1/rooms/me");
    expect(res.status).toBe(200);
    const ids = (res.body.rooms as Array<{ id: string }>).map((r) => r.id);
    // newest, middle, oldest, then quiet (no messages — NULLS LAST).
    expect(ids).toEqual([newest, middle, oldest, quiet]);
  });
});
