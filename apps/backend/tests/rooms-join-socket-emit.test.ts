// Q1 — Socket.IO emit on successful self-join.
// Binding spec: docs/specs/s2-rooms.md §8 Q1 (pre-approved in the agent brief).
//
// On a new-membership INSERT (rowCount>0), server.to(roomId).emit(
//   "room.member.joined", { type, roomId, userId, username, joinedAt }
// ) fans out to sockets already subscribed to that roomId. Existing members
// who previously issued `room.subscribe` see the join live.
//
// Non-negotiable #4: the idempotent-repeat path (already a member) does NOT
// emit. A re-join click would otherwise produce ghost-join toasts for every
// observer in the room.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { eq } from "drizzle-orm";
import { room, roomMember, user } from "@ai-herders/shared/schema";
import type {
  ClientToServerEvents,
  RoomMemberJoinedEvent,
  ServerToClientEvents,
} from "@ai-herders/shared/protocol";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

type TypedClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

async function userIdByEmail(email: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return row.id;
}

async function signUpCookie(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<{ cookie: string; userId: string }> {
  const res = await request(app.server)
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: "password1234", name: username })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  return { cookie, userId: await userIdByEmail(email) };
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

async function insertPublicGroupRoom(name: string): Promise<string> {
  const id = randomUUID();
  await getTestDb()
    .insert(room)
    .values({ id, name, kind: "group", visibility: "public" });
  return id;
}

async function insertMembership(roomId: string, userId: string): Promise<void> {
  await getTestDb()
    .insert(roomMember)
    .values({ id: randomUUID(), roomId, userId });
}

async function subscribe(client: TypedClient, roomId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.emit("room.subscribe", roomId, (res) => {
      if (res.ok) resolve();
      else reject(new Error(`room.subscribe refused for ${roomId}`));
    });
  });
}

function waitForJoined(
  client: TypedClient,
  timeoutMs = 2000,
): Promise<RoomMemberJoinedEvent> {
  return new Promise<RoomMemberJoinedEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("room.member.joined", handler);
      reject(new Error("timeout waiting for room.member.joined"));
    }, timeoutMs);
    const handler = (evt: RoomMemberJoinedEvent): void => {
      clearTimeout(timer);
      client.off("room.member.joined", handler);
      resolve(evt);
    };
    client.on("room.member.joined", handler);
  });
}

async function expectNoJoined(client: TypedClient, windowMs = 400): Promise<void> {
  let fired = false;
  const handler = (): void => {
    fired = true;
  };
  client.on("room.member.joined", handler);
  await new Promise((r) => setTimeout(r, windowMs));
  client.off("room.member.joined", handler);
  if (fired) throw new Error("unexpected room.member.joined emission");
}

describe("REQ-026 socket emit on room self-join", () => {
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

  test("REQ-026 successful self-join delivers room.member.joined to existing room subscribers", async () => {
    const alice = await signUpCookie(app, "r026sock-a@example.com", "r026sock_a");
    const bob = await signUpCookie(app, "r026sock-b@example.com", "r026sock_b");
    const roomId = await insertPublicGroupRoom("r026sock-room-a");
    // Bob is already a member and listening on that room.
    await insertMembership(roomId, bob.userId);

    const bobSocket = await connectClient(baseUrl, bob.cookie);
    try {
      await subscribe(bobSocket, roomId);
      const seen = waitForJoined(bobSocket);

      const joinRes = await request(app.server)
        .post(`/api/v1/rooms/${roomId}/join`)
        .set("cookie", alice.cookie);
      expect(joinRes.status).toBe(200);
      expect(joinRes.body).toEqual({ joined: true });

      const evt = await seen;
      expect(evt.type).toBe("room.member.joined");
      expect(evt.roomId).toBe(roomId);
      expect(evt.userId).toBe(alice.userId);
      expect(evt.username).toBe("r026sock_a");
      expect(typeof evt.joinedAt).toBe("string");
      expect(() => new Date(evt.joinedAt)).not.toThrow();
    } finally {
      bobSocket.close();
    }
  });

  test("REQ-026 idempotent repeat does NOT emit room.member.joined", async () => {
    // Alice joins once (emit fires to bob), then calls join again — the
    // second call is a no-op (joined:false) and MUST be silent. Non-neg #4:
    // re-clicks shouldn't surface ghost-join toasts.
    const alice = await signUpCookie(app, "r026sock-c@example.com", "r026sock_c");
    const bob = await signUpCookie(app, "r026sock-d@example.com", "r026sock_d");
    const roomId = await insertPublicGroupRoom("r026sock-room-b");
    await insertMembership(roomId, bob.userId);

    const bobSocket = await connectClient(baseUrl, bob.cookie);
    try {
      await subscribe(bobSocket, roomId);

      // First join — emit is expected and consumed.
      const seen = waitForJoined(bobSocket);
      await request(app.server)
        .post(`/api/v1/rooms/${roomId}/join`)
        .set("cookie", alice.cookie)
        .expect(200);
      await seen;

      // Second join — no emit within the observation window.
      const silent = expectNoJoined(bobSocket, 300);
      const repeat = await request(app.server)
        .post(`/api/v1/rooms/${roomId}/join`)
        .set("cookie", alice.cookie);
      expect(repeat.status).toBe(200);
      expect(repeat.body).toEqual({ joined: false });
      await silent;
    } finally {
      bobSocket.close();
    }
  });
});
