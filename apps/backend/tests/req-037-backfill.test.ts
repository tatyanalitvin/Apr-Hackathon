// REQ-037 — offline-to-online message backfill via the watermark protocol.
//
// Per ADR-0003, every message broadcast carries {seq, roomHeadSeq}. A client
// that was offline while others sent messages detects the gap on reconnect
// (subscribe.ack.roomHeadSeq > lastSeenSeq) and fills it via
// GET /api/v1/rooms/:id/messages?fromSeq=<lastSeen+1>&toSeq=<head>&limit=<n>.
// This test exercises exactly that flow end-to-end: no new production code,
// just proof that the existing plumbing delivers the 5 missed messages in
// order when bob reconnects.
//
// Harness: reuses the supertest + socket.io-client pattern from
// socket-subscribe.test.ts. Bob's "offline" state is modelled by an
// explicit client.close() (not a navigation) so reconnection is a fresh
// Socket.IO handshake.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { eq } from "drizzle-orm";
import {
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";
import type {
  ClientToServerEvents,
  HistorySliceResponse,
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

interface SignedUp {
  agent: request.Agent;
  userId: string;
  cookieHeader: string;
}

async function registerAgent(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<SignedUp> {
  const agent = request.agent(app.server);
  const res = await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: "password1234", name: username })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
  return { agent, userId: await userIdByEmail(email), cookieHeader };
}

async function createRoom(roomId: string): Promise<void> {
  const db = getTestDb();
  await db.insert(room).values({
    id: roomId,
    name: roomId,
    kind: "group",
    visibility: "public",
    ownerId: null,
  });
  await db.insert(messageSeq).values({ roomId, seq: 0n });
}

async function addMember(roomId: string, userId: string): Promise<void> {
  await getTestDb()
    .insert(roomMember)
    .values({ id: `${roomId}-${userId}`, roomId, userId, role: "member" });
}

async function connectClient(baseUrl: string, cookieHeader: string): Promise<TypedClient> {
  const client: TypedClient = ioClient(baseUrl, {
    transports: ["websocket"],
    extraHeaders: { cookie: cookieHeader },
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("connect_error", (err) => reject(err));
  });
  return client;
}

async function subscribeAndGetHead(
  client: TypedClient,
  roomId: string,
): Promise<bigint> {
  const ack = await new Promise<{ ok: boolean; roomHeadSeq: string }>((resolve) => {
    client.emit("room.subscribe", roomId, (res) => resolve(res));
  });
  expect(ack.ok).toBe(true);
  return BigInt(ack.roomHeadSeq);
}

describe("REQ-037 offline-to-online backfill via watermark", () => {
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

  test("REQ-037 bob disconnects, alice sends 5, bob reconnects and backfills exactly 5 in order", async () => {
    const alice = await registerAgent(app, "req037-alice@example.com", "req037_alice");
    const bob = await registerAgent(app, "req037-bob@example.com", "req037_bob");
    const roomId = "r-req037-backfill";
    await createRoom(roomId);
    await addMember(roomId, alice.userId);
    await addMember(roomId, bob.userId);

    // Bob subscribes; empty room so head is 0. lastSeenSeq = 0.
    const bobClient1 = await connectClient(baseUrl, bob.cookieHeader);
    const headOnFirstSub = await subscribeAndGetHead(bobClient1, roomId);
    expect(headOnFirstSub).toBe(0n);
    const lastSeenSeq = 0n;

    // Bob goes offline — explicit socket close, not just a browser navigate.
    bobClient1.close();
    await new Promise((r) => setTimeout(r, 50));

    // Alice sends 5 messages while bob is offline.
    const sent: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const body = `offline-burst-${i}`;
      sent.push(body);
      const postRes = await alice.agent
        .post(`/api/v1/rooms/${roomId}/messages`)
        .send({ body });
      expect(postRes.status).toBe(201);
    }

    // Bob reconnects. Fresh Socket.IO handshake; subscribe ack reports the
    // new head. Head (5) > lastSeenSeq (0) ⇒ gap detected.
    const bobClient2 = await connectClient(baseUrl, bob.cookieHeader);
    try {
      const headOnReconnect = await subscribeAndGetHead(bobClient2, roomId);
      expect(headOnReconnect).toBe(5n);
      expect(headOnReconnect > lastSeenSeq).toBe(true);

      // Backfill the gap via history API — fromSeq is inclusive in dto.ts,
      // so lastSeenSeq+1 fetches only the unseen tail.
      const fromSeq = (lastSeenSeq + 1n).toString();
      const toSeq = headOnReconnect.toString();
      const historyRes = await bob.agent
        .get(`/api/v1/rooms/${roomId}/messages`)
        .query({ fromSeq, toSeq, limit: 50 });
      expect(historyRes.status).toBe(200);
      const body = historyRes.body as HistorySliceResponse;
      expect(body.roomHeadSeq).toBe("5");
      expect(body.messages).toHaveLength(5);
      expect(body.messages.map((m) => m.body)).toEqual(sent);
      // Order: strictly ascending seq, contiguous 1..5.
      expect(body.messages.map((m) => m.seq)).toEqual(["1", "2", "3", "4", "5"]);
    } finally {
      bobClient2.close();
    }
  });
});
