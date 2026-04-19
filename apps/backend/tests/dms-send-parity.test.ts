// R8 (REQ-062) send parity — a DM send MUST emit message.new with the
// exact same event shape as a group-room send. No new event name, no
// new field. The S1 REQ-034 assertion (seq === roomHeadSeq ===
// message.seq on a fresh send) holds for DM rooms too.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { eq } from "drizzle-orm";
import { friendship, user } from "@ai-herders/shared/schema";
import type {
  ClientToServerEvents,
  MessageNewEvent,
  ServerToClientEvents,
} from "@ai-herders/shared/protocol";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

type TypedClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

interface SignedUp {
  agent: request.Agent;
  userId: string;
  cookieHeader: string;
}

async function register(
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
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return { agent, userId: row.id, cookieHeader };
}

async function addFriendship(a: string, b: string): Promise<void> {
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await getTestDb()
    .insert(friendship)
    .values({ id: randomUUID(), userAId, userBId });
}

async function connectClient(
  baseUrl: string,
  cookieHeader: string,
): Promise<TypedClient> {
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

describe("REQ-062 R8 DM send parity with group rooms", () => {
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

  test("REQ-062 R8 DM send emits message.new with seq===roomHeadSeq===message.seq", async () => {
    const alice = await register(
      app,
      "prt-dm-alice@example.com",
      "prt_dm_alice",
    );
    const bob = await register(app, "prt-dm-bob@example.com", "prt_dm_bob");
    await addFriendship(alice.userId, bob.userId);

    const createRes = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(createRes.status).toBe(201);
    const roomId = createRes.body.roomId as string;

    const bobClient = await connectClient(baseUrl, bob.cookieHeader);
    try {
      const subAck = await new Promise<{ ok: boolean; roomHeadSeq: string }>(
        (resolve) => {
          bobClient.emit("room.subscribe", roomId, (res) => resolve(res));
        },
      );
      expect(subAck.ok).toBe(true);
      expect(subAck.roomHeadSeq).toBe("0");

      const received = new Promise<MessageNewEvent>((resolve) => {
        bobClient.once("message.new", (evt) => resolve(evt));
      });

      const postRes = await alice.agent
        .post(`/api/v1/rooms/${roomId}/messages`)
        .send({ body: "first dm" });
      expect(postRes.status).toBe(201);

      const evt = await Promise.race<MessageNewEvent>([
        received,
        new Promise<MessageNewEvent>((_, reject) =>
          setTimeout(
            () => reject(new Error("timeout waiting for message.new")),
            2000,
          ),
        ),
      ]);

      // Same shape as a group-room send — verbatim with REQ-034.
      expect(evt.type).toBe("message.new");
      expect(evt.roomId).toBe(roomId);
      expect(evt.seq).toBe("1");
      expect(evt.roomHeadSeq).toBe("1");
      expect(evt.message.seq).toBe("1");
      expect(evt.message.body).toBe("first dm");
      expect(evt.message.authorId).toBe(alice.userId);
      expect(evt.message.roomId).toBe(roomId);
    } finally {
      bobClient.close();
    }
  });
});
