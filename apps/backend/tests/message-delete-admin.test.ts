// REQ-212 — v3 §2.5.5 extends message deletion to room admins:
//   "Messages may be deleted:
//      - by the message author
//      - by room admins in room chats"
// DMs (v3 §2.5.1) have no admin concept, so the admin-delete path applies
// only when room.kind = 'group'. Authorship path unchanged.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  friendship,
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { buildDmPairKey } from "../src/routes/dms";
import { flushRedis, getTestDb } from "./db-helpers";

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

async function createGroupRoom(roomId: string, ownerId: string): Promise<void> {
  const db = getTestDb();
  await db.insert(room).values({
    id: roomId,
    name: roomId,
    kind: "group",
    visibility: "public",
    ownerId,
  });
  await db.insert(messageSeq).values({ roomId, seq: 0n });
}

async function addMember(
  roomId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "member",
): Promise<void> {
  await getTestDb()
    .insert(roomMember)
    .values({ id: `${roomId}-${userId}`, roomId, userId, role });
}

async function sendMessage(
  agent: request.Agent,
  roomId: string,
  body: string,
): Promise<string> {
  const res = await agent
    .post(`/api/v1/rooms/${roomId}/messages`)
    .send({ body });
  if (res.status !== 201) {
    throw new Error(`send failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.id as string;
}

describe("REQ-212 DELETE /api/v1/rooms/:id/messages/:msgId admin path (v3 §2.5.5)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await flushRedis();
  });

  test("REQ-212 owner deletes another member's message → 204 soft-delete", async () => {
    const alice = await registerAgent(app, "admdel-owner-a@example.com", "admdel_a");
    const bob = await registerAgent(app, "admdel-owner-b@example.com", "admdel_b");
    await createGroupRoom("r-admdel-owner", alice.userId);
    await addMember("r-admdel-owner", alice.userId, "owner");
    await addMember("r-admdel-owner", bob.userId, "member");
    const messageId = await sendMessage(bob.agent, "r-admdel-owner", "bob speaks");

    const res = await alice.agent.delete(
      `/api/v1/rooms/r-admdel-owner/messages/${messageId}`,
    );
    expect(res.status).toBe(204);

    const [row] = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.id, messageId));
    expect(row.body).toBe("");
    expect(row.deletedAt).not.toBeNull();
    // Authorship and clientMessageId are preserved across the soft-delete
    // (brief §2.5.5 — tombstone still shows the original author name).
    expect(row.authorId).toBe(bob.userId);
  });

  test("REQ-212 promoted admin deletes another member's message → 204", async () => {
    const alice = await registerAgent(app, "admdel-admin-a@example.com", "admdel_adm_a");
    const bob = await registerAgent(app, "admdel-admin-b@example.com", "admdel_adm_b");
    const carol = await registerAgent(app, "admdel-admin-c@example.com", "admdel_adm_c");
    await createGroupRoom("r-admdel-admin", alice.userId);
    await addMember("r-admdel-admin", alice.userId, "owner");
    await addMember("r-admdel-admin", bob.userId, "admin");
    await addMember("r-admdel-admin", carol.userId, "member");
    const messageId = await sendMessage(carol.agent, "r-admdel-admin", "carol speaks");

    const res = await bob.agent.delete(
      `/api/v1/rooms/r-admdel-admin/messages/${messageId}`,
    );
    expect(res.status).toBe(204);

    const [row] = await getTestDb()
      .select({ body: message.body, deletedAt: message.deletedAt })
      .from(message)
      .where(eq(message.id, messageId));
    expect(row.body).toBe("");
    expect(row.deletedAt).not.toBeNull();
  });

  test("REQ-212 plain member deletes another member's message → 403", async () => {
    const alice = await registerAgent(app, "admdel-mbr-a@example.com", "admdel_mbr_a");
    const bob = await registerAgent(app, "admdel-mbr-b@example.com", "admdel_mbr_b");
    await createGroupRoom("r-admdel-mbr", alice.userId);
    await addMember("r-admdel-mbr", alice.userId, "owner");
    await addMember("r-admdel-mbr", bob.userId, "member");
    const messageId = await sendMessage(alice.agent, "r-admdel-mbr", "alice speaks");

    const res = await bob.agent.delete(
      `/api/v1/rooms/r-admdel-mbr/messages/${messageId}`,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "not_message_author" });

    const [row] = await getTestDb()
      .select({ body: message.body, deletedAt: message.deletedAt })
      .from(message)
      .where(eq(message.id, messageId));
    expect(row.body).toBe("alice speaks");
    expect(row.deletedAt).toBeNull();
  });

  test("REQ-212 DMs reject admin-delete path (no admin concept)", async () => {
    // v3 §2.5.1 — DMs have no admin role. The `owner` role attached to the
    // DM creator in routes/dms.ts is a bookkeeping artifact, not permission
    // to delete the counterpart's messages. Self-delete stays open, but a
    // cross-author delete (even from the creator side) must 403.
    const alice = await registerAgent(app, "admdel-dm-a@example.com", "admdel_dm_a");
    const bob = await registerAgent(app, "admdel-dm-b@example.com", "admdel_dm_b");

    // Friend Alice + Bob so the DM create path succeeds (DM precondition).
    const [low, high] =
      alice.userId < bob.userId
        ? [alice.userId, bob.userId]
        : [bob.userId, alice.userId];
    await getTestDb().insert(friendship).values({
      id: `fr-${low}-${high}`,
      userAId: low,
      userBId: high,
    });

    const dmRes = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(dmRes.status).toBe(201);
    const dmRoomId: string = dmRes.body.roomId;

    // Bob sends a message; Alice (DM creator, role='owner' per dms.ts seed)
    // attempts to admin-delete it.
    const messageId = await sendMessage(bob.agent, dmRoomId, "bob dm speaks");

    const res = await alice.agent.delete(
      `/api/v1/rooms/${dmRoomId}/messages/${messageId}`,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "not_message_author" });

    // Sanity — pair key assembled as expected.
    expect(buildDmPairKey(alice.userId, bob.userId)).toBe(`${low}:${high}`);
  });

  test("REQ-212 author self-delete still works (regression)", async () => {
    const alice = await registerAgent(app, "admdel-regr-a@example.com", "admdel_regr_a");
    await createGroupRoom("r-admdel-regr", alice.userId);
    await addMember("r-admdel-regr", alice.userId, "owner");
    const messageId = await sendMessage(alice.agent, "r-admdel-regr", "self");

    const res = await alice.agent.delete(
      `/api/v1/rooms/r-admdel-regr/messages/${messageId}`,
    );
    expect(res.status).toBe(204);

    const [row] = await getTestDb()
      .select({ deletedAt: message.deletedAt })
      .from(message)
      .where(eq(message.id, messageId));
    expect(row.deletedAt).not.toBeNull();
  });

  test("REQ-212 broadcast payload carries deletedByRole='admin' for admin path", async () => {
    // The socket broadcast is captured via a small spy around request.server.io.
    // See admin-online-users.test.ts for the same spy pattern. We assert the
    // payload shape here rather than round-trip a socket client.
    const alice = await registerAgent(app, "admdel-evt-a@example.com", "admdel_evt_a");
    const bob = await registerAgent(app, "admdel-evt-b@example.com", "admdel_evt_b");
    await createGroupRoom("r-admdel-evt", alice.userId);
    await addMember("r-admdel-evt", alice.userId, "owner");
    await addMember("r-admdel-evt", bob.userId, "member");
    const messageId = await sendMessage(bob.agent, "r-admdel-evt", "evt body");

    // Capture the broadcast payload from the server io instance. We wrap
    // `to(...).emit(...)` rather than the socket so we don't need a client.
    const emits: Array<{ event: string; payload: unknown }> = [];
    const origTo = app.io.to.bind(app.io);
    // @ts-expect-error — narrow wrapper for the one room channel we care about.
    app.io.to = ((roomId: string) => {
      const ns = origTo(roomId);
      const origEmit = ns.emit.bind(ns);
      // @ts-expect-error — emit has many overloads; we only inspect one.
      ns.emit = (event: string, payload: unknown) => {
        emits.push({ event, payload });
        return origEmit(event, payload);
      };
      return ns;
    }) as typeof app.io.to;

    try {
      const res = await alice.agent.delete(
        `/api/v1/rooms/r-admdel-evt/messages/${messageId}`,
      );
      expect(res.status).toBe(204);
    } finally {
      // @ts-expect-error — restore the original to()
      app.io.to = origTo;
    }

    const deletedEmit = emits.find((e) => e.event === "message.deleted");
    expect(deletedEmit).toBeDefined();
    expect(deletedEmit!.payload).toMatchObject({
      type: "message.deleted",
      messageId,
      deletedByRole: "admin",
    });
  });

  test("REQ-212 broadcast payload carries deletedByRole='author' on self-delete", async () => {
    const alice = await registerAgent(app, "admdel-evt2-a@example.com", "admdel_evt2_a");
    await createGroupRoom("r-admdel-evt2", alice.userId);
    await addMember("r-admdel-evt2", alice.userId, "owner");
    const messageId = await sendMessage(alice.agent, "r-admdel-evt2", "self evt");

    const emits: Array<{ event: string; payload: unknown }> = [];
    const origTo = app.io.to.bind(app.io);
    // @ts-expect-error — same wrapper pattern as the admin test above
    app.io.to = ((roomId: string) => {
      const ns = origTo(roomId);
      const origEmit = ns.emit.bind(ns);
      // @ts-expect-error — overload gymnastics
      ns.emit = (event: string, payload: unknown) => {
        emits.push({ event, payload });
        return origEmit(event, payload);
      };
      return ns;
    }) as typeof app.io.to;

    try {
      const res = await alice.agent.delete(
        `/api/v1/rooms/r-admdel-evt2/messages/${messageId}`,
      );
      expect(res.status).toBe(204);
    } finally {
      // @ts-expect-error — restore
      app.io.to = origTo;
    }

    const deletedEmit = emits.find((e) => e.event === "message.deleted");
    expect(deletedEmit!.payload).toMatchObject({
      type: "message.deleted",
      messageId,
      deletedByRole: "author",
    });
  });
});
