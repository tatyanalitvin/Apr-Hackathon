import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-203 / REQ-207 (kicked payload) / REQ-208 (forced socket leave).
// Binding spec: docs/specs/s2-moderation.md §4 REQ-203/207/208 + §5 socket-leave design + §6 Task 4.
//
// DELETE /api/v1/rooms/:id/members/:userId — kick-as-ban per v3.docx §2.4.8.
// Owner or admin caller. Transaction: INSERT room_ban (ON CONFLICT DO NOTHING)
// → DELETE room_member → emit room.member.kicked → force-leave all target
// sockets from the room channel via `io.in('user:${target}').socketsLeave(roomId)`.
//
// REQ-208 assertion shape: target has TWO connected sockets both subscribed to
// the room; after the kick both MUST stop receiving broadcasts to that room
// within 500 ms (verified via a follow-up `server.to(roomId).emit('message.new')`
// that neither socket observes). The per-user `user:${userId}` channel is
// auto-joined in socket-auth.ts:44 — REQ-208 relies on that being stable.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { and, eq } from "drizzle-orm";
import { roomBan, roomMember, user } from "@ai-herders/shared/schema";
import type {
  ClientToServerEvents,
  MessageNewEvent,
  RoomMemberKickedEvent,
  ServerToClientEvents,
} from "@ai-herders/shared/protocol";

import { buildApp } from "../src/app";
import { flushRedis, getTestDb } from "./db-helpers";

type TypedClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

interface SignedUpAgent {
  agent: request.Agent;
  cookie: string;
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
  const res = await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  return { agent, cookie, userId: await userIdByEmail(email) };
}

async function createRoomAsOwner(
  app: FastifyInstance,
  email: string,
  username: string,
  name: string,
): Promise<SignedUpAgent & { roomId: string }> {
  const owner = await registerAgent(app, email, username);
  const res = await owner.agent.post("/api/v1/rooms").send({ name });
  if (res.status !== 201) {
    throw new Error(`failed to create room ${name}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { ...owner, roomId: res.body.id as string };
}

async function joinRoom(target: SignedUpAgent, roomId: string): Promise<void> {
  await target.agent.post(`/api/v1/rooms/${roomId}/join`).expect(200);
}

async function roleOf(roomId: string, userId: string): Promise<string | undefined> {
  const [r] = await getTestDb()
    .select({ role: roomMember.role })
    .from(roomMember)
    .where(and(eq(roomMember.roomId, roomId), eq(roomMember.userId, userId)))
    .limit(1);
  return r?.role;
}

async function banRowExists(roomId: string, userId: string): Promise<boolean> {
  const [r] = await getTestDb()
    .select({ id: roomBan.id })
    .from(roomBan)
    .where(and(eq(roomBan.roomId, roomId), eq(roomBan.userId, userId)))
    .limit(1);
  return !!r;
}

async function memberRowExists(roomId: string, userId: string): Promise<boolean> {
  const [r] = await getTestDb()
    .select({ id: roomMember.id })
    .from(roomMember)
    .where(and(eq(roomMember.roomId, roomId), eq(roomMember.userId, userId)))
    .limit(1);
  return !!r;
}

async function connectClient(baseUrl: string, cookie: string): Promise<TypedClient> {
  const client: TypedClient = ioClient(baseUrl, {
    transports: ["websocket"],
    extraHeaders: { cookie },
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("connect_error", (err) => reject(err));
  });
  return client;
}

async function subscribe(client: TypedClient, roomId: string): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    client.emit("room.subscribe", roomId, (res) => {
      resolve(res);
    });
  });
}

function waitForKicked(
  client: TypedClient,
  timeoutMs = 1000,
): Promise<RoomMemberKickedEvent> {
  return new Promise<RoomMemberKickedEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("room.member.kicked", handler);
      reject(new Error("timeout waiting for room.member.kicked"));
    }, timeoutMs);
    const handler = (evt: RoomMemberKickedEvent): void => {
      clearTimeout(timer);
      client.off("room.member.kicked", handler);
      resolve(evt);
    };
    client.on("room.member.kicked", handler);
  });
}

async function expectNoMessageNew(client: TypedClient, windowMs: number): Promise<void> {
  let fired = false;
  const handler = (): void => {
    fired = true;
  };
  client.on("message.new", handler);
  await new Promise((r) => setTimeout(r, windowMs));
  client.off("message.new", handler);
  if (fired) throw new Error("unexpected message.new delivery after kick");
}

describe("REQ-203 / REQ-207 / REQ-208 kick-as-ban", () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await flushRedis();
  });

  test("REQ-203 no cookie → 401", async () => {
    const res = await request(app.server).delete(
      "/api/v1/rooms/00000000-0000-0000-0000-000000000000/members/00000000-0000-0000-0000-000000000001",
    );
    expect(res.status).toBe(401);
  });

  test("REQ-203 unknown room → 404 room_not_found", async () => {
    const alice = await registerAgent(app, "r203-rnf@example.com", "r203_rnf");
    const res = await alice.agent.delete(
      `/api/v1/rooms/00000000-0000-0000-0000-deadbeef0000/members/${alice.userId}`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "room_not_found" });
  });

  test("REQ-203 caller is plain member → 403 not_admin", async () => {
    const alice = await createRoomAsOwner(app, "r203-pm-a@example.com", "r203_pm_a", "R203 Pm");
    const bob = await registerAgent(app, "r203-pm-b@example.com", "r203_pm_b");
    const carol = await registerAgent(app, "r203-pm-c@example.com", "r203_pm_c");
    await joinRoom(bob, alice.roomId);
    await joinRoom(carol, alice.roomId);

    const res = await bob.agent.delete(`/api/v1/rooms/${alice.roomId}/members/${carol.userId}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "not_admin" });
    expect(await memberRowExists(alice.roomId, carol.userId)).toBe(true);
    expect(await banRowExists(alice.roomId, carol.userId)).toBe(false);
  });

  test("REQ-203 target is not a member → 404 user_not_member", async () => {
    const alice = await createRoomAsOwner(app, "r203-unm-a@example.com", "r203_unm_a", "R203 Unm");
    const stranger = await registerAgent(app, "r203-unm-s@example.com", "r203_unm_s");

    const res = await alice.agent.delete(
      `/api/v1/rooms/${alice.roomId}/members/${stranger.userId}`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "user_not_member" });
    expect(await banRowExists(alice.roomId, stranger.userId)).toBe(false);
  });

  test("REQ-203 kicking the owner → 409 cannot_kick_owner", async () => {
    const alice = await createRoomAsOwner(app, "r203-own-a@example.com", "r203_own_a", "R203 Own");
    const bob = await registerAgent(app, "r203-own-b@example.com", "r203_own_b");
    await joinRoom(bob, alice.roomId);
    await alice.agent
      .post(`/api/v1/rooms/${alice.roomId}/admins/${bob.userId}`)
      .expect(200);

    // Bob is now an admin. Try to kick Alice (owner).
    const res = await bob.agent.delete(`/api/v1/rooms/${alice.roomId}/members/${alice.userId}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "cannot_kick_owner" });
    expect(await roleOf(alice.roomId, alice.userId)).toBe("owner");
    expect(await banRowExists(alice.roomId, alice.userId)).toBe(false);
  });

  test("REQ-203 admin cannot kick fellow admin (caller is not owner) → 403 admin_cannot_kick_admin", async () => {
    const alice = await createRoomAsOwner(app, "r203-aka-a@example.com", "r203_aka_a", "R203 Aka");
    const bob = await registerAgent(app, "r203-aka-b@example.com", "r203_aka_b");
    const carol = await registerAgent(app, "r203-aka-c@example.com", "r203_aka_c");
    await joinRoom(bob, alice.roomId);
    await joinRoom(carol, alice.roomId);
    // Promote both bob and carol to admin.
    await alice.agent.post(`/api/v1/rooms/${alice.roomId}/admins/${bob.userId}`).expect(200);
    await alice.agent.post(`/api/v1/rooms/${alice.roomId}/admins/${carol.userId}`).expect(200);

    const res = await bob.agent.delete(`/api/v1/rooms/${alice.roomId}/members/${carol.userId}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "admin_cannot_kick_admin" });
    expect(await memberRowExists(alice.roomId, carol.userId)).toBe(true);
  });

  test("REQ-203 owner CAN kick an admin → 200 {kicked:true, banned:true}", async () => {
    const alice = await createRoomAsOwner(app, "r203-oka-a@example.com", "r203_oka_a", "R203 Oka");
    const bob = await registerAgent(app, "r203-oka-b@example.com", "r203_oka_b");
    await joinRoom(bob, alice.roomId);
    await alice.agent.post(`/api/v1/rooms/${alice.roomId}/admins/${bob.userId}`).expect(200);

    const res = await alice.agent.delete(`/api/v1/rooms/${alice.roomId}/members/${bob.userId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kicked: true, banned: true });
    expect(await memberRowExists(alice.roomId, bob.userId)).toBe(false);
    expect(await banRowExists(alice.roomId, bob.userId)).toBe(true);
  });

  test("REQ-203 admin kicks plain member → 200 + DB row gone + ban row inserted + emit", async () => {
    const alice = await createRoomAsOwner(app, "r203-akm-a@example.com", "r203_akm_a", "R203 Akm");
    const bob = await registerAgent(app, "r203-akm-b@example.com", "r203_akm_b");
    const carol = await registerAgent(app, "r203-akm-c@example.com", "r203_akm_c");
    const doug = await registerAgent(app, "r203-akm-d@example.com", "r203_akm_d");
    await joinRoom(bob, alice.roomId);
    await joinRoom(carol, alice.roomId);
    await joinRoom(doug, alice.roomId);
    await alice.agent.post(`/api/v1/rooms/${alice.roomId}/admins/${bob.userId}`).expect(200);

    // Doug (plain member) observes the kick event.
    const dougSocket = await connectClient(baseUrl, doug.cookie);
    try {
      const sub = await subscribe(dougSocket, alice.roomId);
      expect(sub.ok).toBe(true);
      const seen = waitForKicked(dougSocket);

      const res = await bob.agent.delete(
        `/api/v1/rooms/${alice.roomId}/members/${carol.userId}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ kicked: true, banned: true });

      const evt = await seen;
      expect(evt.type).toBe("room.member.kicked");
      expect(evt.roomId).toBe(alice.roomId);
      expect(evt.userId).toBe(carol.userId);
      expect(evt.kickedBy).toBe(bob.userId);
      expect(typeof evt.kickedAt).toBe("string");
      expect(() => new Date(evt.kickedAt)).not.toThrow();

      expect(await memberRowExists(alice.roomId, carol.userId)).toBe(false);
      expect(await banRowExists(alice.roomId, carol.userId)).toBe(true);
    } finally {
      dougSocket.close();
    }
  });

  test("REQ-203 re-kick of already-gone target → 404 user_not_member (idempotent safety)", async () => {
    const alice = await createRoomAsOwner(app, "r203-rk-a@example.com", "r203_rk_a", "R203 Rk");
    const bob = await registerAgent(app, "r203-rk-b@example.com", "r203_rk_b");
    await joinRoom(bob, alice.roomId);

    const first = await alice.agent.delete(`/api/v1/rooms/${alice.roomId}/members/${bob.userId}`);
    expect(first.status).toBe(200);
    const second = await alice.agent.delete(`/api/v1/rooms/${alice.roomId}/members/${bob.userId}`);
    expect(second.status).toBe(404);
    expect(second.body).toMatchObject({ error: "user_not_member" });
    // Ban row stays (ON CONFLICT DO NOTHING — single row, not duplicated).
    expect(await banRowExists(alice.roomId, bob.userId)).toBe(true);
  });

  test("REQ-208 dual-socket kick: both target sockets force-leave room within 500 ms", async () => {
    const alice = await createRoomAsOwner(app, "r208-ds-a@example.com", "r208_ds_a", "R208 Ds");
    const bob = await registerAgent(app, "r208-ds-b@example.com", "r208_ds_b");
    await joinRoom(bob, alice.roomId);

    const sock1 = await connectClient(baseUrl, bob.cookie);
    const sock2 = await connectClient(baseUrl, bob.cookie);
    try {
      expect((await subscribe(sock1, alice.roomId)).ok).toBe(true);
      expect((await subscribe(sock2, alice.roomId)).ok).toBe(true);

      // Both sockets MUST receive the kick broadcast.
      const kicked1 = waitForKicked(sock1, 500);
      const kicked2 = waitForKicked(sock2, 500);

      const res = await alice.agent.delete(
        `/api/v1/rooms/${alice.roomId}/members/${bob.userId}`,
      );
      expect(res.status).toBe(200);

      const [evt1, evt2] = await Promise.all([kicked1, kicked2]);
      expect(evt1.userId).toBe(bob.userId);
      expect(evt2.userId).toBe(bob.userId);

      // After the kick, a subsequent message.new fanout to the room must NOT
      // reach either of Bob's sockets — the handler must have called
      // socketsLeave for the per-user channel (REQ-208 design note §5).
      const silent1 = expectNoMessageNew(sock1, 400);
      const silent2 = expectNoMessageNew(sock2, 400);

      const msg: MessageNewEvent = {
        type: "message.new",
        roomId: alice.roomId,
        seq: "1",
        roomHeadSeq: "1",
        message: {
          id: "probe-msg",
          roomId: alice.roomId,
          authorId: alice.userId,
          authorUsername: "r208_ds_a",
          authorName: "r208_ds_a",
          body: "post-kick probe",
          seq: "1",
          replyToId: null,
          editedAt: null,
          deletedAt: null,
          createdAt: new Date().toISOString(),
        },
      };
      app.io.to(alice.roomId).emit("message.new", msg);

      await Promise.all([silent1, silent2]);
    } finally {
      sock1.close();
      sock2.close();
    }
  });

  test("REQ-208 kicked user cannot resume room subscription (membership gate re-asserted)", async () => {
    // Complements the dual-socket test above. Even if a client replays
    // `room.subscribe` after the kick (e.g. inside the 2-min
    // connectionStateRecovery window), the server-side membership gate in
    // socket-handlers.ts:101-110 must reject it — there's no room_member row.
    const alice = await createRoomAsOwner(app, "r208-gate-a@example.com", "r208_gate_a", "R208 Gate");
    const bob = await registerAgent(app, "r208-gate-b@example.com", "r208_gate_b");
    await joinRoom(bob, alice.roomId);

    await alice.agent
      .delete(`/api/v1/rooms/${alice.roomId}/members/${bob.userId}`)
      .expect(200);

    const bobSocket = await connectClient(baseUrl, bob.cookie);
    try {
      const ack = await subscribe(bobSocket, alice.roomId);
      expect(ack.ok).toBe(false);
    } finally {
      bobSocket.close();
    }
  });
});
