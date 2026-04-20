import { TEST_PASSWORD_OK } from "./helpers/fixtures";
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
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
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

  // Invisible-message hardening — exploratory bug report 2026-04-20 (B1, B2).
  // Zod min(1) counted bytes, so whitespace-only and zero-width-only bodies
  // were 201 Created and polluted the feed with visible-but-empty rows.
  test("whitespace-only body → 400 (cannot spam blank bubbles)", async () => {
    const { agent, userId } = await registerAgent(app, "blank-ws@example.com", "blank_ws");
    await createRoom("r-blank-ws");
    await addMember("r-blank-ws", userId);

    const res = await agent
      .post("/api/v1/rooms/r-blank-ws/messages")
      .send({ body: "     " });

    expect(res.status).toBe(400);
  });

  test("zero-width-only body → 400 (strips to empty after sanitization)", async () => {
    const { agent, userId } = await registerAgent(app, "blank-zw@example.com", "blank_zw");
    await createRoom("r-blank-zw");
    await addMember("r-blank-zw", userId);

    const res = await agent
      .post("/api/v1/rooms/r-blank-zw/messages")
      .send({ body: "\u200b\u200b\u200b" });

    expect(res.status).toBe(400);
  });

  test("bidi-override-only body → 400 (no visible content survives strip)", async () => {
    const { agent, userId } = await registerAgent(app, "blank-bidi@example.com", "blank_bidi");
    await createRoom("r-blank-bidi");
    await addMember("r-blank-bidi", userId);

    const res = await agent
      .post("/api/v1/rooms/r-blank-bidi/messages")
      .send({ body: "\u202e\u202d\u202e" });

    expect(res.status).toBe(400);
  });

  test("bidi override inside a message is stripped before persist", async () => {
    const { agent, userId } = await registerAgent(app, "bidi-mix@example.com", "bidi_mix");
    await createRoom("r-bidi-mix");
    await addMember("r-bidi-mix", userId);

    const res = await agent
      .post("/api/v1/rooms/r-bidi-mix/messages")
      .send({ body: "hello \u202eworld" });

    expect(res.status).toBe(201);
    expect(res.body.body).toBe("hello world");

    const [row] = await getTestDb()
      .select({ body: message.body })
      .from(message)
      .where(eq(message.roomId, "r-bidi-mix"));
    expect(row.body).toBe("hello world");
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

  // REQ-029 → superseded by s2-replies REQ-110 R1/R2/R3 (tests/message-replies.test.ts):
  // non-UUID `replyToId` is rejected by the zod guard; UUID ids that don't
  // reference a same-room parent return 400 `reply_parent_invalid`. The old
  // S1 "passthrough" behavior is gone by design.

  test("REQ-029 empty attachmentIds → send succeeds, no attachments key", async () => {
    // S2 wires the R12 link step (see docs/specs/s2-attachments.md §4 R12 +
    // tests/attachments-link.test.ts). The old S1 behavior ("accepted but
    // ignored") is replaced: unknown ids now return 400. Empty array is a
    // no-op and the 201 body omits `attachments` (R17 — optional field).
    const { agent, userId } = await registerAgent(app, "req029-att@example.com", "req029_att");
    await createRoom("r-req029-att");
    await addMember("r-req029-att", userId);

    const res = await agent
      .post("/api/v1/rooms/r-req029-att/messages")
      .send({ body: "no files here", attachmentIds: [] });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("attachments");
    expect(res.body).not.toHaveProperty("attachmentIds");
  });
});
