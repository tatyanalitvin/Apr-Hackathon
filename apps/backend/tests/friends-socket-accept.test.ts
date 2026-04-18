// R11 / REQ-058 — Socket.IO emit on accept.
// Binding spec: docs/specs/s2-friendship.md §4 R11 + §6 Socket.IO.
//
// On accept success (R8), the requester (was `fromId` on the request row)
// receives `friend.request.accepted` in their per-user Socket.IO room
// `user:{fromId}` with { type, requestId, friendId, friendUsername, acceptedAt }.
// Decline and Block emit nothing — REQ-058 explicit: "no notification is sent
// to the requester" for those paths.
//
// Per-user room join happens at handshake time in socket-auth.ts; this test
// asserts the round-trip against a live Socket.IO client.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { eq } from "drizzle-orm";
import { friendRequest, user } from "@ai-herders/shared/schema";
import type {
  ClientToServerEvents,
  FriendRequestAcceptedEvent,
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

async function insertFriendRequest(fromId: string, toId: string): Promise<string> {
  const id = randomUUID();
  await getTestDb().insert(friendRequest).values({
    id,
    fromId,
    toId,
    status: "pending",
    message: null,
  });
  return id;
}

function waitForAccepted(
  client: TypedClient,
  timeoutMs = 2000,
): Promise<FriendRequestAcceptedEvent> {
  return new Promise<FriendRequestAcceptedEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("friend.request.accepted", handler);
      reject(new Error("timeout waiting for friend.request.accepted"));
    }, timeoutMs);
    const handler = (evt: FriendRequestAcceptedEvent): void => {
      clearTimeout(timer);
      client.off("friend.request.accepted", handler);
      resolve(evt);
    };
    client.on("friend.request.accepted", handler);
  });
}

async function expectNoAccepted(client: TypedClient, windowMs = 200): Promise<void> {
  let fired = false;
  const handler = (): void => {
    fired = true;
  };
  client.on("friend.request.accepted", handler);
  await new Promise((r) => setTimeout(r, windowMs));
  client.off("friend.request.accepted", handler);
  if (fired) throw new Error("unexpected friend.request.accepted emission");
}

describe("REQ-058 socket emit on friend-request accept", () => {
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

  test("REQ-058 accept delivers friend.request.accepted to the requester's user:{id} room", async () => {
    const alice = await signUpCookie(app, "r058a-alice@example.com", "r058a_alice");
    const bob = await signUpCookie(app, "r058a-bob@example.com", "r058a_bob");
    const reqId = await insertFriendRequest(alice.userId, bob.userId);

    const aliceSocket = await connectClient(baseUrl, alice.cookie);
    try {
      const seen = waitForAccepted(aliceSocket);
      await request(app.server)
        .post(`/api/v1/friends/requests/${reqId}/accept`)
        .set("cookie", bob.cookie)
        .expect(200);
      const evt = await seen;

      expect(evt.type).toBe("friend.request.accepted");
      expect(evt.requestId).toBe(reqId);
      expect(evt.friendId).toBe(bob.userId);
      expect(evt.friendUsername).toBe("r058a_bob");
      expect(typeof evt.acceptedAt).toBe("string");
      expect(() => new Date(evt.acceptedAt)).not.toThrow();
    } finally {
      aliceSocket.close();
    }
  });

  test("REQ-058 accept does not leak to other users' rooms", async () => {
    const alice = await signUpCookie(app, "r058x-alice@example.com", "r058x_alice");
    const bob = await signUpCookie(app, "r058x-bob@example.com", "r058x_bob");
    const eve = await signUpCookie(app, "r058x-eve@example.com", "r058x_eve");
    const reqId = await insertFriendRequest(alice.userId, bob.userId);

    const eveSocket = await connectClient(baseUrl, eve.cookie);
    try {
      const silent = expectNoAccepted(eveSocket, 400);
      await request(app.server)
        .post(`/api/v1/friends/requests/${reqId}/accept`)
        .set("cookie", bob.cookie)
        .expect(200);
      await silent;
    } finally {
      eveSocket.close();
    }
  });
});
