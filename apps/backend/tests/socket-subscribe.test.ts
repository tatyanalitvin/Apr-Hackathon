import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-036 + REQ-040 — Socket.IO room.subscribe/unsubscribe + message.new
// broadcast. Task 7 per docs/specs/s1-chat.md.
//
// Strategy: boot buildApp() and let it listen on a random high port so
// Socket.IO clients can actually dial in. Auth cookies are harvested from
// the better-auth sign-up response and replayed via `extraHeaders` on the
// Socket.IO handshake (pragmatic: Socket.IO's browser client relies on
// `document.cookie`; in node we feed them explicitly).

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
  MessageNewEvent,
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
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  // Supertest stores cookies on the agent; for the Socket.IO handshake we need
  // them as a single `Cookie:` header string.
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

describe("REQ-036/REQ-040 Socket.IO room.subscribe + message.new broadcast", () => {
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

  test("REQ-040 room.subscribe member → ack ok + roomHeadSeq on empty room", async () => {
    const alice = await registerAgent(app, "ws-a-40@example.com", "ws_a_40");
    const roomId = "r-ws-40-a";
    await createRoom(roomId);
    await addMember(roomId, alice.userId);

    const client = await connectClient(baseUrl, alice.cookieHeader);
    try {
      const ack = await new Promise<{ ok: boolean; roomHeadSeq: string }>(
        (resolve) => {
          client.emit("room.subscribe", roomId, (res) => resolve(res));
        },
      );
      expect(ack).toEqual({ ok: true, roomHeadSeq: "0" });
    } finally {
      client.close();
    }
  });

  test("REQ-040 room.subscribe non-member → ack ok=false", async () => {
    const bob = await registerAgent(app, "ws-nm-40@example.com", "ws_nm_40");
    const roomId = "r-ws-40-locked";
    await createRoom(roomId);
    // Bob intentionally NOT added as a member.

    const client = await connectClient(baseUrl, bob.cookieHeader);
    try {
      const ack = await new Promise<{ ok: boolean; roomHeadSeq: string }>(
        (resolve) => {
          client.emit("room.subscribe", roomId, (res) => resolve(res));
        },
      );
      expect(ack.ok).toBe(false);
    } finally {
      client.close();
    }
  });

  test("REQ-036 subscribed client receives message.new on POST", async () => {
    const alice = await registerAgent(app, "ws-a-34@example.com", "ws_a_34");
    const bob = await registerAgent(app, "ws-b-34@example.com", "ws_b_34");
    const roomId = "r-ws-34-broadcast";
    await createRoom(roomId);
    await addMember(roomId, alice.userId);
    await addMember(roomId, bob.userId);

    const bobClient = await connectClient(baseUrl, bob.cookieHeader);
    try {
      const subAck = await new Promise<{ ok: boolean; roomHeadSeq: string }>(
        (resolve) => {
          bobClient.emit("room.subscribe", roomId, (res) => resolve(res));
        },
      );
      expect(subAck.ok).toBe(true);

      const received = new Promise<MessageNewEvent>((resolve) => {
        bobClient.once("message.new", (evt) => resolve(evt));
      });

      const postRes = await alice.agent
        .post(`/api/v1/rooms/${roomId}/messages`)
        .send({ body: "hello from alice" });
      expect(postRes.status).toBe(201);

      const evt = await Promise.race<MessageNewEvent>([
        received,
        new Promise<MessageNewEvent>((_, reject) =>
          setTimeout(() => reject(new Error("timeout waiting for message.new")), 2000),
        ),
      ]);

      expect(evt.type).toBe("message.new");
      expect(evt.roomId).toBe(roomId);
      expect(evt.seq).toBe("1");
      expect(evt.roomHeadSeq).toBe("1");
      expect(evt.message.body).toBe("hello from alice");
      expect(evt.message.seq).toBe("1");
      expect(evt.message.authorId).toBe(alice.userId);
    } finally {
      bobClient.close();
    }
  });

  test("REQ-036 unsubscribed client does NOT receive message.new", async () => {
    const alice = await registerAgent(app, "ws-a-unsub@example.com", "ws_a_unsub");
    const bob = await registerAgent(app, "ws-b-unsub@example.com", "ws_b_unsub");
    const roomId = "r-ws-unsub";
    await createRoom(roomId);
    await addMember(roomId, alice.userId);
    await addMember(roomId, bob.userId);

    const bobClient = await connectClient(baseUrl, bob.cookieHeader);
    try {
      await new Promise<void>((resolve) => {
        bobClient.emit("room.subscribe", roomId, () => resolve());
      });
      bobClient.emit("room.unsubscribe", roomId);
      // Wait a tick so the leave happens before we POST.
      await new Promise((r) => setTimeout(r, 50));

      let got = false;
      bobClient.on("message.new", () => {
        got = true;
      });

      const postRes = await alice.agent
        .post(`/api/v1/rooms/${roomId}/messages`)
        .send({ body: "bob shouldn't hear this" });
      expect(postRes.status).toBe(201);

      await new Promise((r) => setTimeout(r, 200));
      expect(got).toBe(false);
    } finally {
      bobClient.close();
    }
  });

  test("REQ-038 Socket.IO handshake without cookie → connect_error", async () => {
    const client: TypedClient = ioClient(baseUrl, {
      transports: ["websocket"],
      reconnection: false,
    });
    const err = await new Promise<Error>((resolve) => {
      client.once("connect", () => resolve(new Error("should not connect")));
      client.once("connect_error", (e) => resolve(e));
    });
    client.close();
    expect(err.message).not.toBe("should not connect");
  });
});
