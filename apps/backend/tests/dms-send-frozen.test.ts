import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// R5 (REQ-066) freeze-on-send + R6 read-after-freeze.
//
// The DM send path MUST consult the dm-freeze predicate BEFORE
// allocating seq. When frozen, the send returns 409 dialog_frozen with
// NO new message row, NO seq advance, NO socket event emitted.
//
// R6 — GET /api/v1/rooms/:id/messages on a frozen DM still returns all
// prior messages for both members. Freeze affects writes only.
//
// Group rooms (kind='group') MUST skip the predicate entirely — fast
// path.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import {
  friendship,
  message,
  messageSeq,
  room,
  roomMember,
  user,
  userBlock,
} from "@ai-herders/shared/schema";

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
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
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

async function removeFriendship(a: string, b: string): Promise<void> {
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await getTestDb()
    .delete(friendship)
    .where(
      and(eq(friendship.userAId, userAId), eq(friendship.userBId, userBId)),
    );
}

async function createDm(
  agent: request.Agent,
  targetId: string,
): Promise<string> {
  const res = await agent.post("/api/v1/dms").send({ userId: targetId });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`createDm failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.roomId as string;
}

describe("REQ-066 R5 freeze-on-send + R6 read-after-freeze", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-066 R5 unfriend → next send 409 dialog_frozen, no seq advance, no row", async () => {
    const alice = await register(
      app,
      "fr-unf-alice@example.com",
      "fr_unf_alice",
    );
    const bob = await register(app, "fr-unf-bob@example.com", "fr_unf_bob");
    await addFriendship(alice.userId, bob.userId);

    const roomId = await createDm(alice.agent, bob.userId);

    // Three successful sends.
    for (let i = 0; i < 3; i++) {
      const res = await alice.agent
        .post(`/api/v1/rooms/${roomId}/messages`)
        .send({ body: `pre-freeze ${i}` });
      expect(res.status).toBe(201);
    }

    // Snapshot seq before unfriending.
    const [before] = await getTestDb()
      .select({ seq: messageSeq.seq })
      .from(messageSeq)
      .where(eq(messageSeq.roomId, roomId));
    expect(before!.seq).toBe(3n);

    await removeFriendship(alice.userId, bob.userId);

    // Next send is frozen for both sides.
    const frozenA = await alice.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "should be frozen" });
    expect(frozenA.status).toBe(409);
    expect(frozenA.body).toMatchObject({ error: "dialog_frozen" });

    const frozenB = await bob.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "bob also frozen" });
    expect(frozenB.status).toBe(409);
    expect(frozenB.body).toMatchObject({ error: "dialog_frozen" });

    // No seq advance.
    const [after] = await getTestDb()
      .select({ seq: messageSeq.seq })
      .from(messageSeq)
      .where(eq(messageSeq.roomId, roomId));
    expect(after!.seq).toBe(3n);

    // No new message row.
    const msgs = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.roomId, roomId));
    expect(msgs).toHaveLength(3);
  });

  test("REQ-066 R5 block either direction → send 409 dialog_frozen", async () => {
    const alice = await register(
      app,
      "fr-blk-alice@example.com",
      "fr_blk_alice",
    );
    const bob = await register(app, "fr-blk-bob@example.com", "fr_blk_bob");
    await addFriendship(alice.userId, bob.userId);

    const roomId = await createDm(alice.agent, bob.userId);

    // bob blocks alice — alice's send is frozen.
    await getTestDb()
      .insert(userBlock)
      .values({ id: randomUUID(), byId: bob.userId, targetId: alice.userId });

    const blockedA = await alice.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "sneaky" });
    expect(blockedA.status).toBe(409);
    expect(blockedA.body).toMatchObject({ error: "dialog_frozen" });

    // bob's own send is also frozen — freeze is symmetric.
    const blockedB = await bob.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "also frozen" });
    expect(blockedB.status).toBe(409);
    expect(blockedB.body).toMatchObject({ error: "dialog_frozen" });
  });

  test("REQ-066 R6 frozen DM history still readable by both members", async () => {
    const alice = await register(
      app,
      "fr-rd-alice@example.com",
      "fr_rd_alice",
    );
    const bob = await register(app, "fr-rd-bob@example.com", "fr_rd_bob");
    await addFriendship(alice.userId, bob.userId);

    const roomId = await createDm(alice.agent, bob.userId);
    const sent: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await alice.agent
        .post(`/api/v1/rooms/${roomId}/messages`)
        .send({ body: `msg ${i}` });
      expect(res.status).toBe(201);
      sent.push(res.body.id as string);
    }

    await removeFriendship(alice.userId, bob.userId);

    // Both members GET full history.
    const aliceHistory = await alice.agent.get(
      `/api/v1/rooms/${roomId}/messages`,
    );
    expect(aliceHistory.status).toBe(200);
    expect(aliceHistory.body.messages).toHaveLength(5);

    const bobHistory = await bob.agent.get(`/api/v1/rooms/${roomId}/messages`);
    expect(bobHistory.status).toBe(200);
    expect(bobHistory.body.messages).toHaveLength(5);
  });

  test("REQ-062 group rooms skip the freeze predicate (fast path)", async () => {
    // Regression guard: the freeze check MUST only apply to kind='dm'.
    // A group room with no friendship MUST accept sends normally.
    const alice = await register(
      app,
      "fr-grp-alice@example.com",
      "fr_grp_alice",
    );
    // Insert a public group room directly and add alice as owner/member.
    const roomId = randomUUID();
    await getTestDb().insert(room).values({
      id: roomId,
      name: "grp",
      kind: "group",
      visibility: "public",
      ownerId: alice.userId,
    });
    await getTestDb().insert(roomMember).values({
      id: randomUUID(),
      userId: alice.userId,
      roomId,
      role: "owner",
    });
    await getTestDb().insert(messageSeq).values({ roomId });

    const res = await alice.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "group send, no freeze" });
    expect(res.status).toBe(201);

    // Assert the message row is there.
    const msgs = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.roomId, roomId))
      .orderBy(desc(message.seq))
      .limit(1);
    expect(msgs).toHaveLength(1);
  });
});
