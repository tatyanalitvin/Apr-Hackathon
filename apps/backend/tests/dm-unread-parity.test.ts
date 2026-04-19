// §2.7 R7 — DM unread parity.
//
// Audit-only test. GET /api/v1/rooms/me already returns `lastReadSeq` +
// `roomHeadSeq` for every membership row (see rooms-me.test.ts R4), but the
// R4 coverage lands on a `kind='group'` room. This test confirms the same
// contract holds for `kind='dm'` rooms so the web-side badge math
// (`Number(roomHeadSeq) - Number(lastReadSeq)`) is parity-safe between DM
// and group rooms.
//
// ADR-0003 fixture-only shortcut: inserts into `message_seq` + `message`
// directly instead of going through POST /messages. The real route is
// exercised by dms-send-parity.test.ts (R8); here we only care about the
// READ-side projection on /rooms/me, so bypassing the allocator keeps the
// test under 300 ms and independent of socket.io wiring.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { friendship, message, messageSeq, user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

interface SignedUp {
  agent: request.Agent;
  userId: string;
}

async function register(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<SignedUp> {
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
  // userAId < userBId — matches the ordered-uniqueness constraint used
  // elsewhere in the test suite (see dms-send-parity helper).
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await getTestDb()
    .insert(friendship)
    .values({ id: randomUUID(), userAId, userBId });
}

async function seedMessage(
  roomId: string,
  authorId: string,
  authorUsername: string,
  seq: bigint,
  body: string,
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
    body,
    createdAt: new Date(),
  });
}

describe("§2.7 R7 DM unread parity — rooms/me exposes roomHeadSeq / lastReadSeq for DMs", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("§2.7 R7: after Bob sends 3 fixture messages, roomHeadSeq - lastReadSeq === 3 for Alice", async () => {
    const alice = await register(app, "s27-alice@example.com", "s27_alice");
    const bob = await register(app, "s27-bob@example.com", "s27_bob");
    await addFriendship(alice.userId, bob.userId);

    // Alice creates the DM — the POST /api/v1/dms handler owns membership
    // setup for both users (find-or-create semantics per REQ-061).
    const createRes = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(createRes.status).toBe(201);
    const roomId = createRes.body.roomId as string;

    // Seed 3 messages from Bob. Alice's lastReadSeq is still 0n from the
    // membership row the handler wrote, so unread === roomHeadSeq - 0 === 3.
    await seedMessage(roomId, bob.userId, "s27_bob", 1n, "ping");
    await seedMessage(roomId, bob.userId, "s27_bob", 2n, "pong");
    await seedMessage(roomId, bob.userId, "s27_bob", 3n, "pang");

    const res = await alice.agent.get("/api/v1/rooms/me");
    expect(res.status).toBe(200);

    const row = (res.body.rooms as Array<{
      id: string;
      kind: string;
      lastReadSeq: string;
      roomHeadSeq: string;
    }>).find((r) => r.id === roomId);

    expect(row).toBeDefined();
    expect(row?.kind).toBe("dm");
    // §2.7 R7 — parity with group rooms: bigints-as-strings on the wire.
    expect(row?.lastReadSeq).toBe("0");
    expect(row?.roomHeadSeq).toBe("3");
    // Unread math the UI performs — BigInt so a future seq >2^53 still works.
    const unread = BigInt(row!.roomHeadSeq) - BigInt(row!.lastReadSeq);
    expect(unread).toBe(3n);
  });

  test("§2.7 R7: marking DM read advances lastReadSeq and zeroes unread", async () => {
    const alice = await register(app, "s27-alice2@example.com", "s27_alice2");
    const bob = await register(app, "s27-bob2@example.com", "s27_bob2");
    await addFriendship(alice.userId, bob.userId);

    const createRes = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(createRes.status).toBe(201);
    const roomId = createRes.body.roomId as string;

    await seedMessage(roomId, bob.userId, "s27_bob2", 1n, "a");
    await seedMessage(roomId, bob.userId, "s27_bob2", 2n, "b");

    // REQ-120 — /rooms/:id/read accepts lastReadSeq as a bigint-on-the-wire
    // string and returns 200 with `{ roomId, lastReadSeq }`. This is the same
    // endpoint group rooms use; confirming it works for a DM room is the R7
    // parity guarantee.
    const readRes = await alice.agent
      .post(`/api/v1/rooms/${roomId}/read`)
      .send({ lastReadSeq: "2" });
    expect(readRes.status).toBe(200);
    expect(readRes.body).toEqual({ roomId, lastReadSeq: "2" });

    const res = await alice.agent.get("/api/v1/rooms/me");
    expect(res.status).toBe(200);
    const row = (res.body.rooms as Array<{
      id: string;
      lastReadSeq: string;
      roomHeadSeq: string;
    }>).find((r) => r.id === roomId);
    expect(row?.lastReadSeq).toBe("2");
    expect(row?.roomHeadSeq).toBe("2");
    expect(BigInt(row!.roomHeadSeq) - BigInt(row!.lastReadSeq)).toBe(0n);
  });
});
