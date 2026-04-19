// R11 — GET /api/v1/dms. Lists caller's DMs with counterpart, last
// message, unread count (0 placeholder), and frozen state with reason.
// Reason priority: user_deleted > blocked > not_friends.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { friendship, user, userBlock } from "@ai-herders/shared/schema";

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
  return res.body.roomId as string;
}

describe("R11 GET /api/v1/dms listing", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("R11 empty state → { dms: [] }", async () => {
    const alice = await register(
      app,
      "list-empty@example.com",
      "list_empty",
    );
    const res = await alice.agent.get("/api/v1/dms");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dms: [] });
  });

  test("R11 two active DMs, both frozen:false, ordered by lastMessage DESC", async () => {
    const alice = await register(app, "list-a@example.com", "list_a");
    const bob = await register(app, "list-b@example.com", "list_b");
    const carol = await register(app, "list-c@example.com", "list_c");
    await addFriendship(alice.userId, bob.userId);
    await addFriendship(alice.userId, carol.userId);

    const roomAB = await createDm(alice.agent, bob.userId);
    const roomAC = await createDm(alice.agent, carol.userId);

    // Send in AB first, then later in AC — so AC is "newer".
    await alice.agent
      .post(`/api/v1/rooms/${roomAB}/messages`)
      .send({ body: "hi bob" })
      .expect(201);
    await new Promise((r) => setTimeout(r, 20));
    await alice.agent
      .post(`/api/v1/rooms/${roomAC}/messages`)
      .send({ body: "hi carol" })
      .expect(201);

    const res = await alice.agent.get("/api/v1/dms");
    expect(res.status).toBe(200);
    expect(res.body.dms).toHaveLength(2);

    // AC must come first (latest message).
    expect(res.body.dms[0].roomId).toBe(roomAC);
    expect(res.body.dms[1].roomId).toBe(roomAB);

    for (const dm of res.body.dms) {
      expect(dm.frozen).toBe(false);
      expect(dm.frozenReason).toBeNull();
      // REQ-214 — unreadCount is now real math: head - lastReadSeq. Alice
      // sent in both rooms so head=1 each; POST /messages does not
      // auto-advance the sender's lastReadSeq (client does via /read),
      // so Alice sees 1 unread per room until the next /read call.
      expect(dm.unreadCount).toBe(1);
      expect(dm.other.deleted).toBe(false);
      expect(typeof dm.other.username).toBe("string");
      expect(dm.lastMessage).not.toBeNull();
    }

    // The counterpart on roomAB is bob.
    const ab = res.body.dms.find((d: { roomId: string }) => d.roomId === roomAB);
    expect(ab.other.userId).toBe(bob.userId);
    expect(ab.other.username).toBe("list_b");
  });

  test("R11 unfriend → frozen:true, frozenReason:'not_friends'", async () => {
    const alice = await register(app, "list-nf-a@example.com", "list_nf_a");
    const bob = await register(app, "list-nf-b@example.com", "list_nf_b");
    await addFriendship(alice.userId, bob.userId);
    await createDm(alice.agent, bob.userId);
    await removeFriendship(alice.userId, bob.userId);

    const res = await alice.agent.get("/api/v1/dms");
    expect(res.status).toBe(200);
    expect(res.body.dms).toHaveLength(1);
    expect(res.body.dms[0].frozen).toBe(true);
    expect(res.body.dms[0].frozenReason).toBe("not_friends");
  });

  test("R11 block target → frozen:true, frozenReason:'blocked'", async () => {
    const alice = await register(app, "list-bl-a@example.com", "list_bl_a");
    const bob = await register(app, "list-bl-b@example.com", "list_bl_b");
    await addFriendship(alice.userId, bob.userId);
    await createDm(alice.agent, bob.userId);
    // alice blocks bob.
    await getTestDb()
      .insert(userBlock)
      .values({ id: randomUUID(), byId: alice.userId, targetId: bob.userId });

    const res = await alice.agent.get("/api/v1/dms");
    expect(res.status).toBe(200);
    expect(res.body.dms).toHaveLength(1);
    expect(res.body.dms[0].frozen).toBe(true);
    expect(res.body.dms[0].frozenReason).toBe("blocked");
  });

  test("R11 soft-delete counterpart → other.deleted:true + frozenReason:'user_deleted'", async () => {
    // §8 Q6(b) fallback branch — the listing MUST still show the DM
    // with the deleted counterpart and the most-permanent reason wins.
    const alice = await register(app, "list-sd-a@example.com", "list_sd_a");
    const bob = await register(app, "list-sd-b@example.com", "list_sd_b");
    await addFriendship(alice.userId, bob.userId);
    await createDm(alice.agent, bob.userId);

    await getTestDb()
      .update(user)
      .set({ deletedAt: new Date() })
      .where(eq(user.id, bob.userId));

    const res = await alice.agent.get("/api/v1/dms");
    expect(res.status).toBe(200);
    expect(res.body.dms).toHaveLength(1);
    expect(res.body.dms[0].other.deleted).toBe(true);
    expect(res.body.dms[0].frozen).toBe(true);
    expect(res.body.dms[0].frozenReason).toBe("user_deleted");
  });

  test("R11 priority — deleted + blocked → reason:'user_deleted' wins", async () => {
    // Spec §5 priority ladder: user_deleted > blocked > not_friends.
    // Unblocking a deleted-user DM would not actually unfreeze it, so
    // the UI MUST surface the most permanent cause.
    const alice = await register(app, "list-pr-a@example.com", "list_pr_a");
    const bob = await register(app, "list-pr-b@example.com", "list_pr_b");
    await addFriendship(alice.userId, bob.userId);
    await createDm(alice.agent, bob.userId);

    // Block AND soft-delete — deleted wins.
    await getTestDb()
      .insert(userBlock)
      .values({ id: randomUUID(), byId: alice.userId, targetId: bob.userId });
    await getTestDb()
      .update(user)
      .set({ deletedAt: new Date() })
      .where(eq(user.id, bob.userId));

    const res = await alice.agent.get("/api/v1/dms");
    expect(res.status).toBe(200);
    expect(res.body.dms[0].frozenReason).toBe("user_deleted");
  });

  test("R12 listing without cookie → 401", async () => {
    const res = await request(app.server).get("/api/v1/dms");
    expect(res.status).toBe(401);
  });
});
