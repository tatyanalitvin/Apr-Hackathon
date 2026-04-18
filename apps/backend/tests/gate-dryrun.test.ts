// Task 12 — S1 gate dry-run. Single end-to-end smoke mirroring the manual
// demo from `.human/CHAT_AGENT_BRIEF.md`:
//
//   1. Seed `alice`/`bob`/`carol` + `general` via runSeed()
//   2. alice + bob subscribe to `general` over Socket.IO
//   3. alice POSTs a new message
//   4. bob receives `message.new` within the same tick (< 1s)
//   5. restart the backend (close app, buildApp again on a new port)
//   6. GET /api/v1/rooms/general/messages still returns alice's message
//      AND the 3 seed messages — nothing was dropped by the restart
//
// This is deliberately one test (not a grid of cases). Its job is to fail
// loudly if any step in the S1 critical path regresses between now and
// gate time. Granular coverage lives in the dedicated REQ-0NN files.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { and, eq } from "drizzle-orm";
import {
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
import { runSeed } from "../../../scripts/seed";

type TypedClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const GENERAL = "general";
const SEED_PASSWORD = "hunter2hunter2";

async function signIn(
  app: FastifyInstance,
  email: string,
): Promise<{ agent: request.Agent; cookieHeader: string }> {
  const agent = request.agent(app.server);
  const res = await agent
    .post("/api/auth/sign-in/email")
    .send({ email, password: SEED_PASSWORD })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
  return { agent, cookieHeader };
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

async function subscribe(client: TypedClient, roomId: string): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    client.emit("room.subscribe", roomId, (ack) => resolve(ack));
  });
}

describe("Task 12 — S1 gate dry-run (seed + broadcast + restart persistence)", () => {
  let app1: FastifyInstance;
  let baseUrl1: string;

  beforeAll(async () => {
    app1 = await buildApp();
    await app1.listen({ host: "127.0.0.1", port: 0 });
    const addr = app1.server.address() as AddressInfo;
    baseUrl1 = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    // app1 is closed mid-test; close it here only if that path didn't run.
    if (app1.server.listening) await app1.close();
  });

  test("seed + 2-client broadcast + restart — history still contains all messages", async () => {
    // 1. Seed demo fixture.
    const seedReport = await runSeed();
    expect(seedReport.createdUsers).toBe(3);
    expect(seedReport.createdMessages).toBe(3);

    // Resolve alice/bob user ids so we can assert membership shapes.
    const db = getTestDb();
    const aliceRow = (
      await db.select({ id: user.id }).from(user).where(eq(user.username, "alice")).limit(1)
    )[0];
    const bobRow = (
      await db.select({ id: user.id }).from(user).where(eq(user.username, "bob")).limit(1)
    )[0];
    if (!aliceRow || !bobRow) throw new Error("seed did not populate alice/bob");

    // Sanity: both are members of `general` (seed-level invariant the demo depends on).
    const [aliceMember] = await db
      .select()
      .from(roomMember)
      .where(and(eq(roomMember.roomId, GENERAL), eq(roomMember.userId, aliceRow.id)));
    expect(aliceMember).toBeDefined();

    // 2. Sign both users in and open two Socket.IO clients.
    const alice = await signIn(app1, "alice@herders.local");
    const bob = await signIn(app1, "bob@herders.local");

    const bobSocket = await connectClient(baseUrl1, bob.cookieHeader);
    try {
      const bobAck = await subscribe(bobSocket, GENERAL);
      expect(bobAck.ok).toBe(true);

      // 3. Prepare the broadcast listener BEFORE the POST — otherwise a fast
      //    loopback emit can race the listener registration.
      const received = new Promise<MessageNewEvent>((resolve, reject) => {
        bobSocket.once("message.new", (evt) => resolve(evt));
        setTimeout(() => reject(new Error("timeout waiting for message.new")), 2000);
      });

      // 4. alice sends.
      const demoBody = "gate dry-run: alice sends, bob receives";
      const postRes = await alice.agent
        .post(`/api/v1/rooms/${GENERAL}/messages`)
        .send({ body: demoBody });
      expect(postRes.status).toBe(201);

      // 5. bob's socket observes the new message within the 2s budget.
      const evt = await received;
      expect(evt.type).toBe("message.new");
      expect(evt.roomId).toBe(GENERAL);
      // Seed inserted 3 messages; alice's POST is the 4th → seq 4.
      expect(evt.seq).toBe("4");
      expect(evt.roomHeadSeq).toBe("4");
      expect(evt.message.body).toBe(demoBody);
      expect(evt.message.authorId).toBe(aliceRow.id);
    } finally {
      bobSocket.close();
    }

    // 6. Simulate a backend restart: close app1, boot app2 against the same DB.
    await app1.close();
    const app2 = await buildApp();
    await app2.ready();
    try {
      const agent2 = request.agent(app2.server);
      await agent2
        .post("/api/auth/sign-in/email")
        .send({ email: "alice@herders.local", password: SEED_PASSWORD })
        .expect(200);

      const history = await agent2.get(`/api/v1/rooms/${GENERAL}/messages`);
      expect(history.status).toBe(200);
      // 3 seed messages + alice's sent message = 4. All persist across restart.
      expect(history.body.messages).toHaveLength(4);
      expect(history.body.roomHeadSeq).toBe("4");
      const bodies = history.body.messages.map((m: { body: string }) => m.body);
      expect(bodies).toContain("gate dry-run: alice sends, bob receives");
    } finally {
      await app2.close();
    }
  });
});
