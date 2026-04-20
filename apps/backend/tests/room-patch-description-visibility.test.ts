import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-022 / REQ-028 / REQ-087 / REQ-088 — backend coverage for the S3
// widening of PATCH /api/v1/rooms/:id:
//   • description (≤500, NFC, nullable-clear) accepted alongside name
//   • visibility flip public ↔ private
//   • successful PATCH emits room.updated on the room channel
//   • /rooms/me and GET /rooms return description
//   • 1000-member cap (REQ-028) on self-join AND invitation accept returns
//     409 { error: "room_full", cap: 1000 }
//
// Memory "One buildApp per Vitest test file" applies: all assertions share a
// single `buildApp()` + `app.listen()` so better-auth's init doesn't race
// across describes. That's why HTTP and socket tests co-habit this file.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { room, roomInvite, roomMember, user } from "@ai-herders/shared/schema";
import type {
  ClientToServerEvents,
  RoomUpdatedEvent,
  ServerToClientEvents,
} from "@ai-herders/shared/protocol";

import { buildApp } from "../src/app";
import { flushRedis, getTestDb } from "./db-helpers";

type TypedClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

interface SignedUpAgent {
  agent: request.Agent;
  userId: string;
  cookie: string;
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

async function signUp(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<SignedUpAgent> {
  const agent = request.agent(app.server);
  const res = await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  const raw = res.headers["set-cookie"];
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = arr.map((c) => c.split(";")[0]).join("; ");
  return { agent, userId: await userIdByEmail(email), cookie };
}

async function createRoom(
  owner: SignedUpAgent,
  name: string,
  extras: { description?: string; visibility?: "public" | "private" } = {},
): Promise<string> {
  const res = await owner.agent
    .post("/api/v1/rooms")
    .send({ name, ...extras });
  if (res.status !== 201) {
    throw new Error(`createRoom ${name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.id as string;
}

async function connectSocket(baseUrl: string, cookie: string): Promise<TypedClient> {
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

async function subscribeRoom(client: TypedClient, roomId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.emit("room.subscribe", roomId, (res) => {
      if (res.ok) resolve();
      else reject(new Error(`room.subscribe refused for ${roomId}`));
    });
  });
}

function waitForUpdated(
  client: TypedClient,
  timeoutMs = 2000,
): Promise<RoomUpdatedEvent> {
  return new Promise<RoomUpdatedEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("room.updated", handler);
      reject(new Error("timeout waiting for room.updated"));
    }, timeoutMs);
    const handler = (evt: RoomUpdatedEvent): void => {
      clearTimeout(timer);
      client.off("room.updated", handler);
      resolve(evt);
    };
    client.on("room.updated", handler);
  });
}

describe("REQ-022 / REQ-028 / REQ-087 / REQ-088 — widened PATCH + cap + room.updated", () => {
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

  test("REQ-022 owner sets description → 200 + row updated", async () => {
    const alice = await signUp(app, "rd022a@example.com", "rd022_a");
    const roomId = await createRoom(alice, "rd022-room-set");

    const res = await alice.agent
      .patch(`/api/v1/rooms/${roomId}`)
      .send({ description: "  Book club weeknights  " });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: roomId, description: "  Book club weeknights  " });

    const [row] = await getTestDb()
      .select({ description: room.description })
      .from(room)
      .where(eq(room.id, roomId));
    expect(row?.description).toBe("  Book club weeknights  ");
  });

  test("REQ-022 owner clears description with null → stored NULL", async () => {
    const alice = await signUp(app, "rd022b@example.com", "rd022_b");
    const roomId = await createRoom(alice, "rd022-room-clear", { description: "initial" });

    const res = await alice.agent
      .patch(`/api/v1/rooms/${roomId}`)
      .send({ description: null });
    expect(res.status).toBe(200);
    expect(res.body.description).toBeNull();

    const [row] = await getTestDb()
      .select({ description: room.description })
      .from(room)
      .where(eq(room.id, roomId));
    expect(row?.description).toBeNull();
  });

  test("REQ-022 omitted description preserves existing value", async () => {
    const alice = await signUp(app, "rd022c@example.com", "rd022_c");
    const roomId = await createRoom(alice, "rd022-room-preserve", {
      description: "keep me",
    });

    const res = await alice.agent
      .patch(`/api/v1/rooms/${roomId}`)
      .send({ name: "rd022-room-renamed" });
    expect(res.status).toBe(200);

    const [row] = await getTestDb()
      .select({ name: room.name, description: room.description })
      .from(room)
      .where(eq(room.id, roomId));
    expect(row?.name).toBe("rd022-room-renamed");
    expect(row?.description).toBe("keep me");
  });

  test("REQ-022 description over 500 chars → 400", async () => {
    const alice = await signUp(app, "rd022d@example.com", "rd022_d");
    const roomId = await createRoom(alice, "rd022-room-toolong");
    const res = await alice.agent
      .patch(`/api/v1/rooms/${roomId}`)
      .send({ description: "x".repeat(501) });
    expect(res.status).toBe(400);
  });

  test("REQ-022 description strips control characters (NFC transform)", async () => {
    const alice = await signUp(app, "rd022e@example.com", "rd022_e");
    const roomId = await createRoom(alice, "rd022-room-nfc");
    const res = await alice.agent
      .patch(`/api/v1/rooms/${roomId}`)
      .send({ description: "hello\u0000world\u0007" });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe("helloworld");
  });

  test("REQ-088 owner flips visibility public → private", async () => {
    const alice = await signUp(app, "rd088a@example.com", "rd088_a");
    const roomId = await createRoom(alice, "rd088-flip-priv");

    const res = await alice.agent
      .patch(`/api/v1/rooms/${roomId}`)
      .send({ visibility: "private" });
    expect(res.status).toBe(200);
    expect(res.body.visibility).toBe("private");

    const [row] = await getTestDb()
      .select({ visibility: room.visibility })
      .from(room)
      .where(eq(room.id, roomId));
    expect(row?.visibility).toBe("private");
  });

  test("REQ-088 visibility flip preserves name + description", async () => {
    const alice = await signUp(app, "rd088b@example.com", "rd088_b");
    const roomId = await createRoom(alice, "rd088-flip-both", {
      description: "hello",
    });

    const res = await alice.agent
      .patch(`/api/v1/rooms/${roomId}`)
      .send({ visibility: "private" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("rd088-flip-both");
    expect(res.body.description).toBe("hello");
    expect(res.body.visibility).toBe("private");
  });

  test("REQ-022 + REQ-088 combined patch updates all three fields atomically", async () => {
    const alice = await signUp(app, "rd088c@example.com", "rd088_c");
    const roomId = await createRoom(alice, "rd088-combo");

    const res = await alice.agent
      .patch(`/api/v1/rooms/${roomId}`)
      .send({
        name: "rd088-combo-v2",
        description: "combined",
        visibility: "private",
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "rd088-combo-v2",
      description: "combined",
      visibility: "private",
    });
  });

  test("REQ-022 successful PATCH emits room.updated with new payload", async () => {
    const alice = await signUp(app, "rdemit-a@example.com", "rdemit_a");
    const bob = await signUp(app, "rdemit-b@example.com", "rdemit_b");
    const roomId = await createRoom(alice, "rdemit-room", { description: "orig" });
    await bob.agent.post(`/api/v1/rooms/${roomId}/join`).expect(200);

    const bobSocket = await connectSocket(baseUrl, bob.cookie);
    try {
      await subscribeRoom(bobSocket, roomId);
      const seen = waitForUpdated(bobSocket);

      const res = await alice.agent
        .patch(`/api/v1/rooms/${roomId}`)
        .send({ description: "updated", visibility: "private" });
      expect(res.status).toBe(200);

      const evt = await seen;
      expect(evt.type).toBe("room.updated");
      expect(evt.roomId).toBe(roomId);
      expect(evt.description).toBe("updated");
      expect(evt.visibility).toBe("private");
      expect(evt.updatedBy).toBe(alice.userId);
      expect(typeof evt.updatedAt).toBe("string");
    } finally {
      bobSocket.close();
    }
  });

  test("REQ-022 catalog row includes description", async () => {
    const alice = await signUp(app, "rdcat-a@example.com", "rdcat_a");
    const roomId = await createRoom(alice, "rdcat-room", {
      description: "catalog line",
    });
    const res = await alice.agent.get("/api/v1/rooms").expect(200);
    const row = (res.body.rooms as Array<{ id: string; description: string | null }>).find(
      (r) => r.id === roomId,
    );
    expect(row?.description).toBe("catalog line");
  });

  test("REQ-022 /rooms/me row includes description", async () => {
    const alice = await signUp(app, "rdme-a@example.com", "rdme_a");
    const roomId = await createRoom(alice, "rdme-room", {
      description: "sidebar line",
    });
    const res = await alice.agent.get("/api/v1/rooms/me").expect(200);
    const row = (res.body.rooms as Array<{ id: string; description: string | null }>).find(
      (r) => r.id === roomId,
    );
    expect(row?.description).toBe("sidebar line");
  });

  test("REQ-028 join when room already at 1000 members → 409 room_full", async () => {
    const alice = await signUp(app, "rd028join-a@example.com", "rd028_a");
    const bob = await signUp(app, "rd028join-b@example.com", "rd028_b");
    const roomId = await createRoom(alice, "rd028-cap-room");

    // Bulk-seed the room up to the cap. Alice is already member #1 as
    // the owner, so insert 999 synthetic memberships.
    const db = getTestDb();
    const pool = db.$client;
    // Create 999 placeholder user rows via single SQL so we don't burn time
    // on better-auth sign-ups. IDs are UUIDs; columns mirror better-auth's
    // defaults (email/username unique).
    const fillerIds = Array.from({ length: 999 }, () => randomUUID());
    const values = fillerIds
      .map(
        (id, i) =>
          `('${id}','f${i}','rd028f${i}@example.com',false,'rd028f${i}',now(),now())`,
      )
      .join(",");
    await pool.query(
      `INSERT INTO "user" (id,name,email,email_verified,username,created_at,updated_at) VALUES ${values}`,
    );
    const memberValues = fillerIds
      .map((uid) => `('${randomUUID()}','${roomId}','${uid}','member',now(),null)`)
      .join(",");
    await pool.query(
      `INSERT INTO "room_member" (id,room_id,user_id,role,joined_at,muted_until) VALUES ${memberValues}`,
    );

    // Sanity check: cap reached.
    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(roomMember)
      .where(eq(roomMember.roomId, roomId));
    expect(count).toBe(1000);

    const res = await bob.agent.post(`/api/v1/rooms/${roomId}/join`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "room_full", cap: 1000 });
  });

  test("REQ-028 invitation accept when room at cap → 409 room_full, invite stays pending", async () => {
    const alice = await signUp(app, "rd028inv-a@example.com", "rd028inv_a");
    const bob = await signUp(app, "rd028inv-b@example.com", "rd028inv_b");
    const roomId = await createRoom(alice, "rd028-inv-room", {
      visibility: "private",
    });

    // Seed 999 filler members so alice+999 = 1000 at cap.
    const db = getTestDb();
    const pool = db.$client;
    const fillerIds = Array.from({ length: 999 }, () => randomUUID());
    const userValues = fillerIds
      .map(
        (id, i) =>
          `('${id}','iv${i}','rd028inv${i}@example.com',false,'rd028iv${i}',now(),now())`,
      )
      .join(",");
    await pool.query(
      `INSERT INTO "user" (id,name,email,email_verified,username,created_at,updated_at) VALUES ${userValues}`,
    );
    const memberValues = fillerIds
      .map((uid) => `('${randomUUID()}','${roomId}','${uid}','member',now(),null)`)
      .join(",");
    await pool.query(
      `INSERT INTO "room_member" (id,room_id,user_id,role,joined_at,muted_until) VALUES ${memberValues}`,
    );

    // Build a pending invitation alice → bob (bypassing friendship
    // pre-check by seeding the row directly; the accept handler re-reads
    // the row and enforces the cap before the membership insert).
    const inviteId = randomUUID();
    await pool.query(
      `INSERT INTO "room_invite" (id,room_id,inviter_id,invitee_id,status,created_at,expires_at)
       VALUES ($1,$2,$3,$4,'pending',now(),now() + interval '14 days')`,
      [inviteId, roomId, alice.userId, bob.userId],
    );

    const res = await bob.agent.post(`/api/v1/invitations/${inviteId}/accept`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "room_full", cap: 1000 });

    // Invite row should still be 'pending' — accept handler aborts before
    // writing the status transition.
    const [inviteRow] = await db
      .select({ status: roomInvite.status })
      .from(roomInvite)
      .where(eq(roomInvite.id, inviteId));
    expect(inviteRow?.status).toBe("pending");

    // And bob did NOT become a member.
    const [memberRow] = await db
      .select({ id: roomMember.id })
      .from(roomMember)
      .where(and(eq(roomMember.roomId, roomId), eq(roomMember.userId, bob.userId)))
      .limit(1);
    expect(memberRow).toBeUndefined();
  });
});
