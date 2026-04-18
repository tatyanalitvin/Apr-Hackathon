// POST /api/v1/rooms/:id/messages — REQ-029 send message.
// Also exercises REQ-031 (NFC + control-strip) end-to-end through the route
// (the helper is unit-tested in src/lib/message-text.test.ts).

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
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

async function userIdByEmail(email: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return row.id;
}

interface SignedUpAgent {
  agent: request.Agent;
  userId: string;
}

async function registerAgent(app: FastifyInstance, email: string, username: string): Promise<SignedUpAgent> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: "password1234", name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

async function createRoom(roomId: string, ownerId: string | null = null): Promise<void> {
  const db = getTestDb();
  await db.insert(room).values({
    id: roomId,
    name: roomId,
    kind: "group",
    visibility: "public",
    ownerId,
  });
  await db.insert(messageSeq).values({ roomId, seq: 0n });
}

async function addMember(roomId: string, userId: string): Promise<void> {
  await getTestDb()
    .insert(roomMember)
    .values({ id: `${roomId}-${userId}`, roomId, userId, role: "member" });
}

describe("REQ-029 POST /api/v1/rooms/:id/messages send message", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-029 member sends → 201 with MessagePayload shape", async () => {
    const { agent, userId } = await registerAgent(app, "req029-m@example.com", "req029_m");
    await createRoom("r-req029-happy");
    await addMember("r-req029-happy", userId);

    const res = await agent
      .post("/api/v1/rooms/r-req029-happy/messages")
      .send({ body: "hello world" });

    expect(res.status).toBe(201);
    // MessagePayload contract — see packages/shared/src/protocol.ts.
    expect(res.body).toMatchObject({
      roomId: "r-req029-happy",
      authorId: userId,
      body: "hello world",
      replyToId: null,
      editedAt: null,
    });
    expect(typeof res.body.id).toBe("string");
    expect(res.body.seq).toBe("1"); // bigint on the wire is a string
    expect(typeof res.body.createdAt).toBe("string");

    // DB side: one row, seq=1, seq counter advanced.
    const rows = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.roomId, "r-req029-happy"));
    expect(rows).toHaveLength(1);
    expect(rows[0].seq).toBe(1n);
  });

  test("REQ-029 response payload includes authorUsername + authorName (snapshot at send)", async () => {
    // Break #2 from the s1-web walkthrough: MessageList rendered raw
    // `authorId` because MessagePayload carried no human-readable identity.
    // We snapshot username + display-name onto the message row at send time
    // — rename-after-send must not retroactively rewrite history.
    const { agent, userId } = await registerAgent(
      app,
      "req029-ident@example.com",
      "req029_ident",
    );
    await createRoom("r-req029-ident");
    await addMember("r-req029-ident", userId);

    const res = await agent
      .post("/api/v1/rooms/r-req029-ident/messages")
      .send({ body: "who am I" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      authorId: userId,
      authorUsername: "req029_ident",
      authorName: "req029_ident",
    });

    // DB side: snapshot columns populated on the row.
    const [row] = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.roomId, "r-req029-ident"));
    expect(row.authorUsername).toBe("req029_ident");
    expect(row.authorName).toBe("req029_ident");
  });

  test("REQ-030 body over 3072 chars → 400 validation", async () => {
    const { agent, userId } = await registerAgent(app, "req029-big@example.com", "req029_big");
    await createRoom("r-req029-big");
    await addMember("r-req029-big", userId);

    const res = await agent
      .post("/api/v1/rooms/r-req029-big/messages")
      .send({ body: "a".repeat(3073) });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  test("REQ-030 empty body → 400 validation", async () => {
    const { agent, userId } = await registerAgent(app, "req029-empty@example.com", "req029_empty");
    await createRoom("r-req029-empty");
    await addMember("r-req029-empty", userId);

    const res = await agent
      .post("/api/v1/rooms/r-req029-empty/messages")
      .send({ body: "" });

    expect(res.status).toBe(400);
  });

  test("REQ-029 no cookie → 401 unauthorized", async () => {
    await createRoom("r-req029-nocookie");
    const res = await request(app.server)
      .post("/api/v1/rooms/r-req029-nocookie/messages")
      .send({ body: "hi" });

    expect(res.status).toBe(401);
  });

  test("REQ-029 authed non-member → 403 forbidden", async () => {
    const { agent } = await registerAgent(app, "req029-non@example.com", "req029_non");
    await createRoom("r-req029-locked");
    // Note: user is authenticated but not a member of this room.

    const res = await agent
      .post("/api/v1/rooms/r-req029-locked/messages")
      .send({ body: "nope" });

    expect(res.status).toBe(403);
  });

  test("REQ-029 authed but room does not exist → 403 (no oracle)", async () => {
    const { agent } = await registerAgent(app, "req029-ghost@example.com", "req029_ghost");

    const res = await agent
      .post("/api/v1/rooms/does-not-exist/messages")
      .send({ body: "hi" });

    expect(res.status).toBe(403);
  });

  test("REQ-031 stored body is NFC-normalized and control-chars stripped", async () => {
    const { agent, userId } = await registerAgent(app, "req031-nfc@example.com", "req031_nfc");
    await createRoom("r-req031-nfc");
    await addMember("r-req031-nfc", userId);

    // "café" with decomposed é + bell char + NUL.
    const dirty = "caf\u0065\u0301\u0007\u0000 yo";
    const res = await agent
      .post("/api/v1/rooms/r-req031-nfc/messages")
      .send({ body: dirty });

    expect(res.status).toBe(201);
    expect(res.body.body).toBe("caf\u00e9 yo");

    const [row] = await getTestDb()
      .select({ body: message.body })
      .from(message)
      .where(eq(message.roomId, "r-req031-nfc"));
    expect(row.body).toBe("caf\u00e9 yo");
  });

  test("REQ-029 replyToId passthrough (not validated against FK in S1)", async () => {
    const { agent, userId } = await registerAgent(app, "req029-reply@example.com", "req029_reply");
    await createRoom("r-req029-reply");
    await addMember("r-req029-reply", userId);

    const res = await agent
      .post("/api/v1/rooms/r-req029-reply/messages")
      .send({ body: "re: nothing", replyToId: "not-yet-validated" });

    expect(res.status).toBe(201);
    expect(res.body.replyToId).toBe("not-yet-validated");
  });

  test("REQ-029 attachmentIds accepted but ignored in S1", async () => {
    const { agent, userId } = await registerAgent(app, "req029-att@example.com", "req029_att");
    await createRoom("r-req029-att");
    await addMember("r-req029-att", userId);

    const res = await agent
      .post("/api/v1/rooms/r-req029-att/messages")
      .send({ body: "with an ignored attachment", attachmentIds: ["a-1", "a-2"] });

    expect(res.status).toBe(201);
    // Field is intentionally absent from MessagePayload — see spec §2 non-goals.
    expect(res.body).not.toHaveProperty("attachmentIds");
  });
});
