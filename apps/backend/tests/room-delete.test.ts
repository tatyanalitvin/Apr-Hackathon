import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-089 integration tests for DELETE /api/v1/rooms/:id.
// Owner-only (room.ownerId === user.id). DM rooms rejected.
// Cascades: room_member, message, message_seq via FK ON DELETE CASCADE.
// Broadcasts `room.deleted` to subscribed members before the row vanishes.
//
// Binding: .human/S2_ROOM_MGMT_UI_AGENT_BRIEF.md §1a, §1c, §1d.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { eq } from "drizzle-orm";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import {
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";
import type {
  ClientToServerEvents,
  RoomDeletedEvent,
  ServerToClientEvents,
} from "@ai-herders/shared/protocol";

import { buildApp } from "../src/app";
import { env } from "../src/env";
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
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  return { agent, userId: await userIdByEmail(email), cookie };
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
    throw new Error(`failed to create room ${name}: ${res.status}`);
  }
  return { ...owner, roomId: res.body.id as string };
}

async function seedMessage(roomId: string, authorId: string): Promise<void> {
  // Seed a single message at seq=1 to prove cascade removes rows on delete.
  // Also bumps message_seq so history-replay tooling stays in sync with the
  // watermark while the row exists.
  await getTestDb().insert(message).values({
    id: randomUUID(),
    roomId,
    authorId,
    authorUsername: "seeder",
    authorName: "Seeder",
    seq: 1n,
    body: "hello",
  });
  await getTestDb()
    .update(messageSeq)
    .set({ seq: 1n })
    .where(eq(messageSeq.roomId, roomId));
}

describe("REQ-089 DELETE /api/v1/rooms/:id", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await flushRedis();
  });

  test("REQ-089 no cookie → 401", async () => {
    const res = await request(app.server).delete(
      "/api/v1/rooms/some-id",
    );
    expect(res.status).toBe(401);
  });

  test("REQ-089 owner deletes → 204 + cascade removes room/members/messages/seq", async () => {
    const alice = await createRoomAsOwner(
      app,
      "r089o@example.com",
      "r089_o",
      "R089 Owner Room",
    );
    // Bob joins → two room_member rows, exercises the cascade.
    const bob = await registerAgent(app, "r089ob@example.com", "r089_ob");
    await bob.agent.post(`/api/v1/rooms/${alice.roomId}/join`).expect(200);
    await seedMessage(alice.roomId, alice.userId);

    const res = await alice.agent.delete(`/api/v1/rooms/${alice.roomId}`);
    expect(res.status).toBe(204);

    const rooms = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.id, alice.roomId));
    expect(rooms).toHaveLength(0);

    const members = await getTestDb()
      .select()
      .from(roomMember)
      .where(eq(roomMember.roomId, alice.roomId));
    expect(members).toHaveLength(0);

    const messages = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.roomId, alice.roomId));
    expect(messages).toHaveLength(0);

    const seqRows = await getTestDb()
      .select()
      .from(messageSeq)
      .where(eq(messageSeq.roomId, alice.roomId));
    expect(seqRows).toHaveLength(0);

    // /rooms/me no longer surfaces the deleted room.
    const meRes = await alice.agent.get("/api/v1/rooms/me");
    expect(meRes.status).toBe(200);
    const stillSeesDeleted = (meRes.body.rooms as { id: string }[]).some(
      (r) => r.id === alice.roomId,
    );
    expect(stillSeesDeleted).toBe(false);
  });

  test("REQ-089 non-owner → 403, row preserved", async () => {
    const alice = await createRoomAsOwner(
      app,
      "r089na@example.com",
      "r089_na",
      "R089 Non-Owner",
    );
    const bob = await registerAgent(app, "r089nb@example.com", "r089_nb");
    await bob.agent.post(`/api/v1/rooms/${alice.roomId}/join`).expect(200);

    const res = await bob.agent.delete(`/api/v1/rooms/${alice.roomId}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "not_room_owner" });

    const rooms = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.id, alice.roomId));
    expect(rooms).toHaveLength(1);
  });

  test("REQ-089 room not found → 404", async () => {
    const alice = await registerAgent(app, "r089nf@example.com", "r089_nf");
    const res = await alice.agent.delete(
      "/api/v1/rooms/00000000-0000-0000-0000-deadbeef0000",
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "room_not_found" });
  });

  test("REQ-089 DM delete rejected → 403, row preserved", async () => {
    const alice = await registerAgent(app, "r089da@example.com", "r089_da");
    const barry = await registerAgent(app, "r089db@example.com", "r089_db");

    const [lo, hi] =
      alice.userId < barry.userId
        ? [alice.userId, barry.userId]
        : [barry.userId, alice.userId];
    const dmRoomId = randomUUID();
    await getTestDb().insert(room).values({
      id: dmRoomId,
      name: null,
      kind: "dm",
      visibility: "private",
      ownerId: alice.userId,
      dmPairKey: `${lo}:${hi}`,
    });

    const res = await alice.agent.delete(`/api/v1/rooms/${dmRoomId}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "cannot_delete_dm_via_this_route" });

    const rows = await getTestDb().select().from(room).where(eq(room.id, dmRoomId));
    expect(rows).toHaveLength(1);
  });

  test("REQ-089 rate limit: 5 deletes succeed, 6th → 429", async () => {
    // Rate-limit runs BEFORE the resolve step (same ordering rationale as
    // room-join's §5). Five bogus-id DELETEs each 404 AND burn the bucket;
    // the 6th — against a real owned room — should 429 without even
    // reaching the resolve step. Avoids wrestling the POST /rooms burst
    // limit (3/60s) that would otherwise cap room creation here.
    const alice = await createRoomAsOwner(
      app,
      "r089r@example.com",
      "r089_r",
      "R089 RL Owner Room",
    );
    for (let i = 0; i < 5; i++) {
      const res = await alice.agent.delete(
        `/api/v1/rooms/00000000-0000-0000-0000-00000000000${i}`,
      );
      expect(res.status).toBe(404);
    }
    const denied = await alice.agent.delete(`/api/v1/rooms/${alice.roomId}`);
    expect(denied.status).toBe(429);
    expect(denied.body).toMatchObject({ error: "rate_limited" });
    expect(typeof denied.body.retryAfterSec).toBe("number");

    // Real room still there — 429 short-circuits before delete runs.
    const rows = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.id, alice.roomId));
    expect(rows).toHaveLength(1);
  });

  test("REQ-089 rate limit: pre-seeded bucket → denied on first attempt", async () => {
    const alice = await createRoomAsOwner(
      app,
      "r089rp@example.com",
      "r089_rp",
      "R089 RL Preseed",
    );
    const c = createClient({ url: env.REDIS_URL });
    await c.connect();
    await c.set(`rate:room-delete:${alice.userId}`, "5");
    await c.expire(`rate:room-delete:${alice.userId}`, 60 * 60);
    await c.quit();

    const res = await alice.agent.delete(`/api/v1/rooms/${alice.roomId}`);
    expect(res.status).toBe(429);

    // Row still there.
    const rows = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.id, alice.roomId));
    expect(rows).toHaveLength(1);
  });
});

describe("REQ-089 Socket.IO room.deleted broadcast", () => {
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

  test("REQ-089 existing subscribers receive room.deleted on owner delete", async () => {
    // Alice owns; Bob joins and listens. Emission fires BEFORE the DB row
    // disappears so Bob's subscription still routes the event.
    const alice = await createRoomAsOwner(
      app,
      "r089sa@example.com",
      "r089_sa",
      "R089 Socket Room",
    );
    const bob = await registerAgent(app, "r089sb@example.com", "r089_sb");
    await request(app.server)
      .post(`/api/v1/rooms/${alice.roomId}/join`)
      .set("cookie", bob.cookie)
      .expect(200);

    const bobSocket: TypedClient = ioClient(baseUrl, {
      transports: ["websocket"],
      extraHeaders: { cookie: bob.cookie },
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      bobSocket.once("connect", () => resolve());
      bobSocket.once("connect_error", (err) => reject(err));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        bobSocket.emit("room.subscribe", alice.roomId, (res) => {
          if (res.ok) resolve();
          else reject(new Error("subscribe refused"));
        });
      });

      const seen = new Promise<RoomDeletedEvent>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timeout waiting for room.deleted")),
          2000,
        );
        bobSocket.once("room.deleted", (evt) => {
          clearTimeout(timer);
          resolve(evt);
        });
      });

      const del = await request(app.server)
        .delete(`/api/v1/rooms/${alice.roomId}`)
        .set("cookie", alice.cookie);
      expect(del.status).toBe(204);

      const evt = await seen;
      expect(evt.type).toBe("room.deleted");
      expect(evt.roomId).toBe(alice.roomId);
      expect(evt.deletedBy).toBe(alice.userId);
      expect(typeof evt.deletedAt).toBe("string");
      expect(() => new Date(evt.deletedAt)).not.toThrow();
    } finally {
      bobSocket.close();
    }
  });
});
