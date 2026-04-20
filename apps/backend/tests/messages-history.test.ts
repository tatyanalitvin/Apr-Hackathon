import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// GET /api/v1/rooms/:id/messages — REQ-035 history + gap-fill and
// REQ-034 persistence-across-restart.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";
import { allocateAndInsertMessage } from "../src/lib/seq-allocator";

async function userIdByEmail(email: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return row.id;
}

async function registerAgent(app: FastifyInstance, email: string, username: string) {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

async function createRoom(roomId: string, ownerId: string | null = null) {
  await getTestDb().insert(room).values({
    id: roomId,
    name: roomId,
    kind: "group",
    visibility: "public",
    ownerId,
  });
  await getTestDb().insert(messageSeq).values({ roomId, seq: 0n });
}

async function addMember(roomId: string, userId: string) {
  await getTestDb()
    .insert(roomMember)
    .values({ id: `${roomId}-${userId}`, roomId, userId, role: "member" });
}

async function seedMessages(roomId: string, authorId: string, count: number): Promise<bigint[]> {
  const seqs: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const { message: row } = await allocateAndInsertMessage({
      messageId: randomUUID(),
      roomId,
      authorId,
      authorUsername: "test_seed",
      authorName: "Test Seed",
      body: `seeded-${i}`,
    });
    seqs.push(row.seq);
  }
  return seqs;
}

describe("REQ-035 GET /api/v1/rooms/:id/messages history + gap-fill", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-035 member with no params → newest 50 ascending, bigints as strings", async () => {
    const { agent, userId } = await registerAgent(app, "req035-a@example.com", "req035_a");
    await createRoom("r-req035-a");
    await addMember("r-req035-a", userId);
    await seedMessages("r-req035-a", userId, 60);

    const res = await agent.get("/api/v1/rooms/r-req035-a/messages");
    expect(res.status).toBe(200);

    expect(res.body).toMatchObject({
      roomId: "r-req035-a",
    });
    // HistorySliceResponse wire shape: bigints as strings.
    expect(typeof res.body.roomHeadSeq).toBe("string");
    expect(res.body.roomHeadSeq).toBe("60");
    expect(typeof res.body.fromSeq).toBe("string");
    expect(typeof res.body.toSeq).toBe("string");

    expect(res.body.messages).toHaveLength(50);
    // Ascending by seq.
    const seqs: string[] = res.body.messages.map((m: { seq: string }) => m.seq);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => String(11 + i)));
    // Newest window fromSeq=11, toSeq=60.
    expect(res.body.fromSeq).toBe("11");
    expect(res.body.toSeq).toBe("60");
    for (const m of res.body.messages) {
      expect(typeof m.seq).toBe("string");
    }
  });

  test("REQ-035 fromSeq/toSeq slice returns inclusive range ascending", async () => {
    const { agent, userId } = await registerAgent(app, "req035-b@example.com", "req035_b");
    await createRoom("r-req035-b");
    await addMember("r-req035-b", userId);
    await seedMessages("r-req035-b", userId, 20);

    const res = await agent
      .get("/api/v1/rooms/r-req035-b/messages")
      .query({ fromSeq: 5, toSeq: 10 });

    expect(res.status).toBe(200);
    expect(res.body.fromSeq).toBe("5");
    expect(res.body.toSeq).toBe("10");
    expect(res.body.messages.map((m: { seq: string }) => m.seq)).toEqual([
      "5", "6", "7", "8", "9", "10",
    ]);
  });

  test("REQ-035 limit is capped at 200 (zod clamps invalid values)", async () => {
    const { agent, userId } = await registerAgent(app, "req035-c@example.com", "req035_c");
    await createRoom("r-req035-c");
    await addMember("r-req035-c", userId);
    await seedMessages("r-req035-c", userId, 25);

    // limit=300 exceeds zod's max(200). The zod schema rejects rather than
    // silently clamps, so this is a 400. The frontend should send ≤200.
    const res = await agent
      .get("/api/v1/rooms/r-req035-c/messages")
      .query({ limit: 300 });

    expect(res.status).toBe(400);
  });

  test("REQ-035 limit=200 returns up to 200 messages", async () => {
    const { agent, userId } = await registerAgent(app, "req035-d@example.com", "req035_d");
    await createRoom("r-req035-d");
    await addMember("r-req035-d", userId);
    await seedMessages("r-req035-d", userId, 250);

    const res = await agent
      .get("/api/v1/rooms/r-req035-d/messages")
      .query({ limit: 200 });

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(200);
    // Newest window: fromSeq=51, toSeq=250.
    expect(res.body.fromSeq).toBe("51");
    expect(res.body.toSeq).toBe("250");
    expect(res.body.roomHeadSeq).toBe("250");
  });

  test("REQ-035 excludes soft-deleted messages", async () => {
    const { agent, userId } = await registerAgent(app, "req035-e@example.com", "req035_e");
    await createRoom("r-req035-e");
    await addMember("r-req035-e", userId);
    await seedMessages("r-req035-e", userId, 5);

    // Soft-delete seq=3.
    await getTestDb()
      .update(message)
      .set({ deletedAt: new Date() })
      .where(eq(message.seq, 3n));

    const res = await agent.get("/api/v1/rooms/r-req035-e/messages");
    expect(res.status).toBe(200);
    const returnedSeqs = res.body.messages.map((m: { seq: string }) => m.seq);
    expect(returnedSeqs).toEqual(["1", "2", "4", "5"]);
  });

  test("REQ-035 no cookie → 401", async () => {
    await createRoom("r-req035-401");
    const res = await request(app.server).get("/api/v1/rooms/r-req035-401/messages");
    expect(res.status).toBe(401);
  });

  test("REQ-035 authed non-member → 403", async () => {
    const { agent } = await registerAgent(app, "req035-403@example.com", "req035_403");
    await createRoom("r-req035-403-locked");
    const res = await agent.get("/api/v1/rooms/r-req035-403-locked/messages");
    expect(res.status).toBe(403);
  });

  test("REQ-035 empty room returns roomHeadSeq=0 and empty slice", async () => {
    const { agent, userId } = await registerAgent(app, "req035-f@example.com", "req035_f");
    await createRoom("r-req035-f");
    await addMember("r-req035-f", userId);

    const res = await agent.get("/api/v1/rooms/r-req035-f/messages");
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(0);
    expect(res.body.roomHeadSeq).toBe("0");
    expect(res.body.fromSeq).toBe("0");
    expect(res.body.toSeq).toBe("0");
  });
});

describe("REQ-034 messages survive backend re-bootstrap", () => {
  test("REQ-034 buildApp() teardown + re-bootstrap still returns inserted message", async () => {
    // First bootstrap: send a message.
    const app1 = await buildApp();
    await app1.ready();
    const { agent, userId } = await registerAgent(app1, "req036-p@example.com", "req036_p");
    await createRoom("r-req036-p");
    await addMember("r-req036-p", userId);

    const postRes = await agent
      .post("/api/v1/rooms/r-req036-p/messages")
      .send({ body: "persist me" });
    expect(postRes.status).toBe(201);
    await app1.close();

    // Second bootstrap: fresh app, new agent, new sign-in, GET the history.
    const app2 = await buildApp();
    await app2.ready();
    try {
      const agent2 = request.agent(app2.server);
      await agent2
        .post("/api/auth/sign-in/email")
        .send({ email: "req036-p@example.com", password: TEST_PASSWORD_OK })
        .expect(200);

      const res = await agent2.get("/api/v1/rooms/r-req036-p/messages");
      expect(res.status).toBe(200);
      expect(res.body.messages).toHaveLength(1);
      expect(res.body.messages[0].body).toBe("persist me");
      expect(res.body.messages[0].seq).toBe("1");
    } finally {
      await app2.close();
    }
  });
});
