// REQ-214 — v3 §2.7.1 / §4.4 DM unread badges.
// GET /api/v1/dms must compute `unreadCount = max(0, headSeq - lastReadSeq)`
// per DM room, NOT the `0` placeholder the old handler returned.
//
// Same fixture shortcut as dm-unread-parity.test.ts: insert into messageSeq +
// message directly so we can set `seq` deterministically without booting the
// full socket.io allocator. The READ-side projection is what we care about.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  friendship,
  message,
  messageSeq,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

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
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await getTestDb()
    .insert(friendship)
    .values({ id: randomUUID(), userAId, userBId });
}

async function createDm(
  agent: request.Agent,
  targetId: string,
): Promise<string> {
  const res = await agent.post("/api/v1/dms").send({ userId: targetId });
  if (res.status !== 201) {
    throw new Error(`createDm failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.roomId as string;
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

async function setLastReadSeq(
  roomId: string,
  userId: string,
  seq: bigint,
): Promise<void> {
  await getTestDb()
    .update(roomMember)
    .set({ lastReadSeq: seq })
    .where(
      and(eq(roomMember.roomId, roomId), eq(roomMember.userId, userId)),
    );
}

describe("REQ-214 GET /api/v1/dms unreadCount math", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-214: empty DM (no messages) → unreadCount === 0", async () => {
    const alice = await register(
      app,
      "uc-empty-a@example.com",
      "uc_empty_a",
    );
    const bob = await register(app, "uc-empty-b@example.com", "uc_empty_b");
    await addFriendship(alice.userId, bob.userId);
    await createDm(alice.agent, bob.userId);

    const res = await alice.agent.get("/api/v1/dms");
    expect(res.status).toBe(200);
    expect(res.body.dms).toHaveLength(1);
    expect(res.body.dms[0].unreadCount).toBe(0);
  });

  test("REQ-214: 3 unread messages from peer → unreadCount === 3", async () => {
    const alice = await register(app, "uc-three-a@example.com", "uc_three_a");
    const bob = await register(app, "uc-three-b@example.com", "uc_three_b");
    await addFriendship(alice.userId, bob.userId);
    const roomId = await createDm(alice.agent, bob.userId);

    // Alice's membership row starts at lastReadSeq=0. Seed 3 from Bob.
    await seedMessage(roomId, bob.userId, "uc_three_b", 1n, "one");
    await seedMessage(roomId, bob.userId, "uc_three_b", 2n, "two");
    await seedMessage(roomId, bob.userId, "uc_three_b", 3n, "three");

    const res = await alice.agent.get("/api/v1/dms");
    expect(res.status).toBe(200);
    const dm = res.body.dms.find(
      (d: { roomId: string }) => d.roomId === roomId,
    );
    expect(dm).toBeDefined();
    expect(dm.unreadCount).toBe(3);
  });

  test("REQ-214: lastReadSeq === headSeq → unreadCount === 0", async () => {
    const alice = await register(app, "uc-read-a@example.com", "uc_read_a");
    const bob = await register(app, "uc-read-b@example.com", "uc_read_b");
    await addFriendship(alice.userId, bob.userId);
    const roomId = await createDm(alice.agent, bob.userId);

    await seedMessage(roomId, bob.userId, "uc_read_b", 1n, "a");
    await seedMessage(roomId, bob.userId, "uc_read_b", 2n, "b");
    await setLastReadSeq(roomId, alice.userId, 2n);

    const res = await alice.agent.get("/api/v1/dms");
    const dm = res.body.dms.find(
      (d: { roomId: string }) => d.roomId === roomId,
    );
    expect(dm.unreadCount).toBe(0);
  });

  test("REQ-214: lastReadSeq > headSeq clamps to 0 (defensive)", async () => {
    // Stale client acks shouldn't ever produce a negative badge. Clamp at 0.
    const alice = await register(app, "uc-clamp-a@example.com", "uc_clamp_a");
    const bob = await register(app, "uc-clamp-b@example.com", "uc_clamp_b");
    await addFriendship(alice.userId, bob.userId);
    const roomId = await createDm(alice.agent, bob.userId);

    await seedMessage(roomId, bob.userId, "uc_clamp_b", 1n, "a");
    await setLastReadSeq(roomId, alice.userId, 99n);

    const res = await alice.agent.get("/api/v1/dms");
    const dm = res.body.dms.find(
      (d: { roomId: string }) => d.roomId === roomId,
    );
    expect(dm.unreadCount).toBe(0);
  });

  test("REQ-214: partial-read (lastReadSeq between 0 and head) → unreadCount === head - lastRead", async () => {
    const alice = await register(app, "uc-mid-a@example.com", "uc_mid_a");
    const bob = await register(app, "uc-mid-b@example.com", "uc_mid_b");
    await addFriendship(alice.userId, bob.userId);
    const roomId = await createDm(alice.agent, bob.userId);

    await seedMessage(roomId, bob.userId, "uc_mid_b", 1n, "a");
    await seedMessage(roomId, bob.userId, "uc_mid_b", 2n, "b");
    await seedMessage(roomId, bob.userId, "uc_mid_b", 3n, "c");
    await seedMessage(roomId, bob.userId, "uc_mid_b", 4n, "d");
    await setLastReadSeq(roomId, alice.userId, 2n);

    const res = await alice.agent.get("/api/v1/dms");
    const dm = res.body.dms.find(
      (d: { roomId: string }) => d.roomId === roomId,
    );
    expect(dm.unreadCount).toBe(2);
  });

  test("REQ-214: multi-DM — each row carries its own unreadCount", async () => {
    const alice = await register(app, "uc-multi-a@example.com", "uc_multi_a");
    const bob = await register(app, "uc-multi-b@example.com", "uc_multi_b");
    const carol = await register(
      app,
      "uc-multi-c@example.com",
      "uc_multi_c",
    );
    await addFriendship(alice.userId, bob.userId);
    await addFriendship(alice.userId, carol.userId);
    const roomAB = await createDm(alice.agent, bob.userId);
    const roomAC = await createDm(alice.agent, carol.userId);

    await seedMessage(roomAB, bob.userId, "uc_multi_b", 1n, "x");
    await seedMessage(roomAC, carol.userId, "uc_multi_c", 1n, "y");
    await seedMessage(roomAC, carol.userId, "uc_multi_c", 2n, "z");

    const res = await alice.agent.get("/api/v1/dms");
    const ab = res.body.dms.find(
      (d: { roomId: string }) => d.roomId === roomAB,
    );
    const ac = res.body.dms.find(
      (d: { roomId: string }) => d.roomId === roomAC,
    );
    expect(ab.unreadCount).toBe(1);
    expect(ac.unreadCount).toBe(2);
  });
});
