// REQ-100..102 — room-scoped `presence.changed` fanout integration.
//
// End-to-end on a live Fastify + Socket.IO app: alice and bob are members
// of the same room, bob is subscribed; alice connects / goes away /
// disconnects and bob sees a `presence.changed` event for each transition.
//
// Scope boundary (brief §1a): the tracker fans out to room_member rows, so
// a non-member should NEVER see presence for someone they don't share a
// room with. REQ-101 pins that privacy boundary.
//
// Parallel to `socket-presence.test.ts` (S1 `presence.state` global fanout
// with online/afk/offline) — kept so both events can coexist until S1 is
// retired. Filter handlers by event name, not by user id alone.

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
  PresenceChangedEvent,
  ServerToClientEvents,
} from "@ai-herders/shared/protocol";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";
import { __resetPresenceForTests } from "../src/lib/presence";

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

function waitForPresenceChanged(
  client: TypedClient,
  match: (evt: PresenceChangedEvent) => boolean,
  timeoutMs = 2500,
): Promise<PresenceChangedEvent> {
  return new Promise<PresenceChangedEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("presence.changed", handler);
      reject(new Error("timeout waiting for presence.changed"));
    }, timeoutMs);
    const handler = (evt: PresenceChangedEvent): void => {
      if (!match(evt)) return;
      clearTimeout(timer);
      client.off("presence.changed", handler);
      resolve(evt);
    };
    client.on("presence.changed", handler);
  });
}

async function expectNoPresenceChanged(
  client: TypedClient,
  match: (evt: PresenceChangedEvent) => boolean,
  windowMs: number,
): Promise<void> {
  let fired: PresenceChangedEvent | null = null;
  const handler = (evt: PresenceChangedEvent): void => {
    if (match(evt)) fired = evt;
  };
  client.on("presence.changed", handler);
  await new Promise((r) => setTimeout(r, windowMs));
  client.off("presence.changed", handler);
  if (fired) {
    throw new Error(
      `unexpected presence.changed: ${JSON.stringify(fired)}`,
    );
  }
}

describe("REQ-100 presence.changed room-scoped fanout", () => {
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

  test("REQ-100 bob receives alice's online → away → offline via presence.changed", async () => {
    __resetPresenceForTests();
    const alice = await signUpCookie(app, "r100-alice@example.com", "r100_alice");
    const bob = await signUpCookie(app, "r100-bob@example.com", "r100_bob");
    const roomId = await insertPublicGroupRoom("r100-room");
    await insertMembership(roomId, alice.userId);
    await insertMembership(roomId, bob.userId);

    const bobSocket = await connectClient(baseUrl, bob.cookie);
    try {
      await subscribe(bobSocket, roomId);

      // Alice connects — bob should see online.
      const onlineSeen = waitForPresenceChanged(
        bobSocket,
        (e) => e.userId === alice.userId && e.state === "online",
      );
      const aliceSocket = await connectClient(baseUrl, alice.cookie);
      const onlineEvt = await onlineSeen;
      expect(onlineEvt.type).toBe("presence.changed");
      expect(typeof onlineEvt.updatedAt).toBe("string");
      expect(() => new Date(onlineEvt.updatedAt)).not.toThrow();

      try {
        // Alice goes AFK.
        const awaySeen = waitForPresenceChanged(
          bobSocket,
          (e) => e.userId === alice.userId && e.state === "away",
        );
        aliceSocket.emit("presence.setState", { state: "away" });
        const awayEvt = await awaySeen;
        expect(awayEvt.state).toBe("away");

        // Alice disconnects; bob sees offline after the 2s debounce.
        const offlineSeen = waitForPresenceChanged(
          bobSocket,
          (e) => e.userId === alice.userId && e.state === "offline",
          4_000,
        );
        aliceSocket.close();
        const offlineEvt = await offlineSeen;
        expect(offlineEvt.state).toBe("offline");
      } finally {
        if (aliceSocket.connected) aliceSocket.close();
      }
    } finally {
      bobSocket.close();
    }
  });

  test("REQ-101 presence.changed does not fan out to non-members of the room", async () => {
    __resetPresenceForTests();
    const alice = await signUpCookie(app, "r101-alice@example.com", "r101_alice");
    const bob = await signUpCookie(app, "r101-bob@example.com", "r101_bob");
    const eve = await signUpCookie(app, "r101-eve@example.com", "r101_eve");
    const sharedRoom = await insertPublicGroupRoom("r101-shared");
    const privateRoom = await insertPublicGroupRoom("r101-private");
    // Alice + bob share a room. Eve sees neither.
    await insertMembership(sharedRoom, alice.userId);
    await insertMembership(sharedRoom, bob.userId);
    await insertMembership(privateRoom, eve.userId);

    const eveSocket = await connectClient(baseUrl, eve.cookie);
    try {
      await subscribe(eveSocket, privateRoom);

      const silent = expectNoPresenceChanged(
        eveSocket,
        (e) => e.userId === alice.userId,
        400,
      );
      const aliceSocket = await connectClient(baseUrl, alice.cookie);
      try {
        await silent;
      } finally {
        aliceSocket.close();
      }
    } finally {
      eveSocket.close();
    }
  });
});
