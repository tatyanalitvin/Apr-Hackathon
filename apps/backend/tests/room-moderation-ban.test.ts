import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-204 (pre-emptive ban + ban-of-existing-member) / REQ-205 (unban) /
// REQ-206 (ban list) / REQ-207 (banned + unbanned payloads) / REQ-208
// (forced socket leave on ban-of-member path).
// Binding spec: docs/specs/s2-moderation.md §4 REQ-204/205/206/207/208 +
// §5 socket-leave design + §6 Task 5.
//
// Also exercises the /rooms/:id/join ban gate — spec §4 user story says
// "his rejoin attempt returns 403" for a kicked/banned user. The gate
// lives in the pre-existing /rooms/:id/join handler (rooms.ts:117) and is
// extended in this task to check `room_ban`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { and, eq } from "drizzle-orm";
import { roomBan, roomMember, user } from "@ai-herders/shared/schema";
import type {
  ClientToServerEvents,
  RoomMemberBannedEvent,
  RoomMemberKickedEvent,
  RoomMemberUnbannedEvent,
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

async function promoteToAdmin(
  owner: SignedUpAgent,
  roomId: string,
  targetUserId: string,
): Promise<void> {
  await owner.agent
    .post(`/api/v1/rooms/${roomId}/admins/${targetUserId}`)
    .expect(200);
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

function waitForEvent<K extends keyof ServerToClientEvents>(
  client: TypedClient,
  ev: K,
  timeoutMs = 1000,
): Promise<Parameters<ServerToClientEvents[K]>[0]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off(ev, handler as never);
      reject(new Error(`timeout waiting for ${String(ev)}`));
    }, timeoutMs);
    const handler = (evt: unknown): void => {
      clearTimeout(timer);
      client.off(ev, handler as never);
      resolve(evt as never);
    };
    client.on(ev, handler as never);
  });
}

async function expectNoEvent<K extends keyof ServerToClientEvents>(
  client: TypedClient,
  ev: K,
  windowMs: number,
): Promise<void> {
  let fired = false;
  const handler = (): void => {
    fired = true;
  };
  client.on(ev, handler as never);
  await new Promise((r) => setTimeout(r, windowMs));
  client.off(ev, handler as never);
  if (fired) throw new Error(`unexpected ${String(ev)} delivery`);
}

describe("REQ-204 / REQ-205 / REQ-206 / REQ-207 / REQ-208 ban / unban / list", () => {
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

  // ─── REQ-204 POST /rooms/:id/bans ─────────────────────────────────────

  test("REQ-204 no cookie → 401", async () => {
    const res = await request(app.server)
      .post(`/api/v1/rooms/00000000-0000-0000-0000-000000000000/bans`)
      .send({ userId: "x" });
    expect(res.status).toBe(401);
  });

  test("REQ-204 unknown room → 404 room_not_found", async () => {
    const alice = await registerAgent(app, "b01@t.test", "b01alice");
    const res = await alice.agent
      .post(`/api/v1/rooms/00000000-0000-0000-0000-000000000000/bans`)
      .send({ userId: alice.userId });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "room_not_found" });
  });

  test("REQ-204 caller plain member → 403 not_admin", async () => {
    const alice = await createRoomAsOwner(app, "b02a@t.test", "b02alice", "Room B02");
    const bob = await registerAgent(app, "b02b@t.test", "b02bob");
    const carol = await registerAgent(app, "b02c@t.test", "b02carol");
    await joinRoom(bob, alice.roomId);

    const res = await bob.agent
      .post(`/api/v1/rooms/${alice.roomId}/bans`)
      .send({ userId: carol.userId });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "not_admin" });
  });

  test("REQ-204 unknown target user → 404 user_not_found", async () => {
    const alice = await createRoomAsOwner(app, "b03a@t.test", "b03alice", "Room B03");
    const res = await alice.agent
      .post(`/api/v1/rooms/${alice.roomId}/bans`)
      .send({ userId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "user_not_found" });
  });

  test("REQ-204 reason > 500 chars → 400 invalid_body", async () => {
    const alice = await createRoomAsOwner(app, "b04a@t.test", "b04alice", "Room B04");
    const bob = await registerAgent(app, "b04b@t.test", "b04bob");
    const res = await alice.agent
      .post(`/api/v1/rooms/${alice.roomId}/bans`)
      .send({ userId: bob.userId, reason: "x".repeat(501) });
    expect(res.status).toBe(400);
  });

  test("REQ-204 pre-emptive ban of non-member → 200 {banned:true, kicked:false} + room_ban row + banned event", async () => {
    const alice = await createRoomAsOwner(app, "b05a@t.test", "b05alice", "Room B05");
    const bob = await registerAgent(app, "b05b@t.test", "b05bob");

    // Alice's socket to observe room.member.banned broadcast.
    const aliceSock = await connectClient(baseUrl, alice.cookie);
    expect((await subscribe(aliceSock, alice.roomId)).ok).toBe(true);
    const bannedP = waitForEvent(aliceSock, "room.member.banned", 1000);

    const res = await alice.agent
      .post(`/api/v1/rooms/${alice.roomId}/bans`)
      .send({ userId: bob.userId, reason: "spam" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ banned: true, kicked: false });

    const evt = (await bannedP) as RoomMemberBannedEvent;
    expect(evt.type).toBe("room.member.banned");
    expect(evt.roomId).toBe(alice.roomId);
    expect(evt.userId).toBe(bob.userId);
    expect(evt.bannedBy).toBe(alice.userId);
    expect(evt.reason).toBe("spam");
    expect(typeof evt.bannedAt).toBe("string");

    expect(await banRowExists(alice.roomId, bob.userId)).toBe(true);
    aliceSock.disconnect();
  });

  test("REQ-204 ban of existing member → 200 {banned:true, kicked:true} + row gone + kicked event + REQ-208 force-leave", async () => {
    const alice = await createRoomAsOwner(app, "b06a@t.test", "b06alice", "Room B06");
    const bob = await registerAgent(app, "b06b@t.test", "b06bob");
    await joinRoom(bob, alice.roomId);

    const bobSock1 = await connectClient(baseUrl, bob.cookie);
    const bobSock2 = await connectClient(baseUrl, bob.cookie);
    expect((await subscribe(bobSock1, alice.roomId)).ok).toBe(true);
    expect((await subscribe(bobSock2, alice.roomId)).ok).toBe(true);

    const kicked1 = waitForEvent(bobSock1, "room.member.kicked", 500);
    const kicked2 = waitForEvent(bobSock2, "room.member.kicked", 500);

    const res = await alice.agent
      .post(`/api/v1/rooms/${alice.roomId}/bans`)
      .send({ userId: bob.userId, reason: "repeat spam" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ banned: true, kicked: true });

    const evt1 = (await kicked1) as RoomMemberKickedEvent;
    const evt2 = (await kicked2) as RoomMemberKickedEvent;
    expect(evt1.type).toBe("room.member.kicked");
    expect(evt1.kickedBy).toBe(alice.userId);
    expect(evt2.type).toBe("room.member.kicked");

    expect(await banRowExists(alice.roomId, bob.userId)).toBe(true);
    expect(await memberRowExists(alice.roomId, bob.userId)).toBe(false);

    // REQ-208: follow-up fanout must NOT land on either Bob socket.
    const silent1 = expectNoEvent(bobSock1, "message.new", 400);
    const silent2 = expectNoEvent(bobSock2, "message.new", 400);
    app.io.to(alice.roomId).emit("message.new", {
      type: "message.new",
      roomId: alice.roomId,
      seq: "0",
      roomHeadSeq: "0",
      message: {
        id: "probe",
        roomId: alice.roomId,
        authorId: alice.userId,
        authorUsername: "b06alice",
        authorName: "b06alice",
        body: "probe",
        seq: "0",
        replyToId: null,
        editedAt: null,
        deletedAt: null,
        createdAt: new Date().toISOString(),
      },
    });
    await Promise.all([silent1, silent2]);

    bobSock1.disconnect();
    bobSock2.disconnect();
  });

  test("REQ-204 duplicate active ban → 409 already_banned", async () => {
    const alice = await createRoomAsOwner(app, "b07a@t.test", "b07alice", "Room B07");
    const bob = await registerAgent(app, "b07b@t.test", "b07bob");

    await alice.agent
      .post(`/api/v1/rooms/${alice.roomId}/bans`)
      .send({ userId: bob.userId })
      .expect(200);

    const res = await alice.agent
      .post(`/api/v1/rooms/${alice.roomId}/bans`)
      .send({ userId: bob.userId });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "already_banned" });
  });

  test("REQ-203 (rejoin gate) / REQ-204 — banned user hitting /rooms/:id/join gets 403 banned_from_room", async () => {
    const alice = await createRoomAsOwner(app, "b08a@t.test", "b08alice", "Room B08");
    const bob = await registerAgent(app, "b08b@t.test", "b08bob");
    await joinRoom(bob, alice.roomId);

    await alice.agent
      .delete(`/api/v1/rooms/${alice.roomId}/members/${bob.userId}`)
      .expect(200);

    const res = await bob.agent.post(`/api/v1/rooms/${alice.roomId}/join`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "banned_from_room" });
  });

  test("REQ-204 admin (promoted) can ban a member", async () => {
    const alice = await createRoomAsOwner(app, "b09a@t.test", "b09alice", "Room B09");
    const bob = await registerAgent(app, "b09b@t.test", "b09bob");
    const carol = await registerAgent(app, "b09c@t.test", "b09carol");
    await joinRoom(bob, alice.roomId);
    await joinRoom(carol, alice.roomId);
    await promoteToAdmin(alice, alice.roomId, carol.userId);

    const res = await carol.agent
      .post(`/api/v1/rooms/${alice.roomId}/bans`)
      .send({ userId: bob.userId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ banned: true, kicked: true });
  });

  // ─── REQ-205 DELETE /rooms/:id/bans/:userId ───────────────────────────

  test("REQ-205 no cookie → 401", async () => {
    const res = await request(app.server).delete(
      `/api/v1/rooms/00000000-0000-0000-0000-000000000000/bans/00000000-0000-0000-0000-000000000000`,
    );
    expect(res.status).toBe(401);
  });

  test("REQ-205 unknown room → 404 room_not_found", async () => {
    const alice = await registerAgent(app, "u01@t.test", "u01alice");
    const res = await alice.agent.delete(
      `/api/v1/rooms/00000000-0000-0000-0000-000000000000/bans/${alice.userId}`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "room_not_found" });
  });

  test("REQ-205 caller plain member → 403 not_admin", async () => {
    const alice = await createRoomAsOwner(app, "u02a@t.test", "u02alice", "Room U02");
    const bob = await registerAgent(app, "u02b@t.test", "u02bob");
    const carol = await registerAgent(app, "u02c@t.test", "u02carol");
    await joinRoom(bob, alice.roomId);
    await alice.agent
      .post(`/api/v1/rooms/${alice.roomId}/bans`)
      .send({ userId: carol.userId })
      .expect(200);

    const res = await bob.agent.delete(
      `/api/v1/rooms/${alice.roomId}/bans/${carol.userId}`,
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "not_admin" });
  });

  test("REQ-205 no active ban → 404 ban_not_found", async () => {
    const alice = await createRoomAsOwner(app, "u03a@t.test", "u03alice", "Room U03");
    const bob = await registerAgent(app, "u03b@t.test", "u03bob");
    const res = await alice.agent.delete(
      `/api/v1/rooms/${alice.roomId}/bans/${bob.userId}`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "ban_not_found" });
  });

  test("REQ-205 success → 200 {unbanned:true} + row gone + unbanned event + target can rejoin", async () => {
    const alice = await createRoomAsOwner(app, "u04a@t.test", "u04alice", "Room U04");
    const bob = await registerAgent(app, "u04b@t.test", "u04bob");

    await alice.agent
      .post(`/api/v1/rooms/${alice.roomId}/bans`)
      .send({ userId: bob.userId, reason: "bye" })
      .expect(200);

    const aliceSock = await connectClient(baseUrl, alice.cookie);
    expect((await subscribe(aliceSock, alice.roomId)).ok).toBe(true);
    const unbannedP = waitForEvent(aliceSock, "room.member.unbanned", 1000);

    const res = await alice.agent.delete(
      `/api/v1/rooms/${alice.roomId}/bans/${bob.userId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unbanned: true });

    const evt = (await unbannedP) as RoomMemberUnbannedEvent;
    expect(evt.type).toBe("room.member.unbanned");
    expect(evt.roomId).toBe(alice.roomId);
    expect(evt.userId).toBe(bob.userId);
    expect(evt.unbannedBy).toBe(alice.userId);
    expect(typeof evt.unbannedAt).toBe("string");

    expect(await banRowExists(alice.roomId, bob.userId)).toBe(false);

    // Bob can now rejoin per REQ-205.
    const rejoin = await bob.agent.post(`/api/v1/rooms/${alice.roomId}/join`);
    expect(rejoin.status).toBe(200);
    expect(rejoin.body).toEqual({ joined: true });

    aliceSock.disconnect();
  });

  // ─── REQ-206 GET /rooms/:id/bans ──────────────────────────────────────

  test("REQ-206 no cookie → 401", async () => {
    const res = await request(app.server).get(
      `/api/v1/rooms/00000000-0000-0000-0000-000000000000/bans`,
    );
    expect(res.status).toBe(401);
  });

  test("REQ-206 unknown room → 404 room_not_found", async () => {
    const alice = await registerAgent(app, "l01@t.test", "l01alice");
    const res = await alice.agent.get(
      `/api/v1/rooms/00000000-0000-0000-0000-000000000000/bans`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "room_not_found" });
  });

  test("REQ-206 caller plain member → 403 not_admin", async () => {
    const alice = await createRoomAsOwner(app, "l02a@t.test", "l02alice", "Room L02");
    const bob = await registerAgent(app, "l02b@t.test", "l02bob");
    await joinRoom(bob, alice.roomId);

    const res = await bob.agent.get(`/api/v1/rooms/${alice.roomId}/bans`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "not_admin" });
  });

  test("REQ-206 owner sees empty list when no bans", async () => {
    const alice = await createRoomAsOwner(app, "l03a@t.test", "l03alice", "Room L03");
    const res = await alice.agent.get(`/api/v1/rooms/${alice.roomId}/bans`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bans: [] });
  });

  test("REQ-206 returns ban list ordered by bannedAt DESC with joined usernames", async () => {
    const alice = await createRoomAsOwner(app, "l04a@t.test", "l04alice", "Room L04");
    const bob = await registerAgent(app, "l04b@t.test", "l04bob");
    const carol = await registerAgent(app, "l04c@t.test", "l04carol");
    const dave = await registerAgent(app, "l04d@t.test", "l04dave");
    await joinRoom(carol, alice.roomId);
    await promoteToAdmin(alice, alice.roomId, carol.userId);

    // Bob banned first by Alice (no reason).
    await alice.agent
      .post(`/api/v1/rooms/${alice.roomId}/bans`)
      .send({ userId: bob.userId })
      .expect(200);
    // 50ms delay so bannedAt ordering is deterministic even at same second.
    await new Promise((r) => setTimeout(r, 50));
    // Dave banned second by Carol (admin) with reason.
    await carol.agent
      .post(`/api/v1/rooms/${alice.roomId}/bans`)
      .send({ userId: dave.userId, reason: "loud" })
      .expect(200);

    const res = await alice.agent.get(`/api/v1/rooms/${alice.roomId}/bans`);
    expect(res.status).toBe(200);
    expect(res.body.bans).toHaveLength(2);
    expect(res.body.bans[0]).toMatchObject({
      userId: dave.userId,
      username: "l04dave",
      bannedById: carol.userId,
      bannedByUsername: "l04carol",
      reason: "loud",
    });
    expect(res.body.bans[1]).toMatchObject({
      userId: bob.userId,
      username: "l04bob",
      bannedById: alice.userId,
      bannedByUsername: "l04alice",
      reason: null,
    });
    expect(typeof res.body.bans[0].bannedAt).toBe("string");
  });

  test("REQ-206 admin can read ban list", async () => {
    const alice = await createRoomAsOwner(app, "l05a@t.test", "l05alice", "Room L05");
    const bob = await registerAgent(app, "l05b@t.test", "l05bob");
    const carol = await registerAgent(app, "l05c@t.test", "l05carol");
    await joinRoom(carol, alice.roomId);
    await promoteToAdmin(alice, alice.roomId, carol.userId);
    await alice.agent
      .post(`/api/v1/rooms/${alice.roomId}/bans`)
      .send({ userId: bob.userId })
      .expect(200);

    const res = await carol.agent.get(`/api/v1/rooms/${alice.roomId}/bans`);
    expect(res.status).toBe(200);
    expect(res.body.bans).toHaveLength(1);
  });
});
