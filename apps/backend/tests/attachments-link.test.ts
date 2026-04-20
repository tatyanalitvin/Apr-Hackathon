import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// R12 / R17 — link step on POST /api/v1/rooms/:id/messages.
// Binding spec: docs/specs/s2-attachments.md §4 R12, R17.
//
// R12 = SELECT orphan attachment rows WHERE uploader_id = caller AND
// room_id = target AND messageId IS NULL FOR UPDATE; UPDATE messageId.
// All inside the same transaction as the message INSERT + seq allocation.
// Failure branches: (a) happy path, (b) wrong uploader, (c) wrong room, (d)
// already linked (messageId not null). On failure: 400 attachment_invalid,
// no message inserted, seq NOT advanced, attachment stays messageId=NULL.
//
// R17 = the 201 body + history slice both carry the AttachmentPayload[]
// inline on MessagePayload.attachments.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  attachment,
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

interface SignedUpAgent {
  agent: request.Agent;
  userId: string;
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
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

async function createRoomWithSeq(roomId: string): Promise<void> {
  await getTestDb().insert(room).values({
    id: roomId,
    name: roomId,
    kind: "group",
    visibility: "public",
    ownerId: null,
  });
  // seq allocator assumes the row exists; it's normally seeded by room-create.
  await getTestDb().insert(messageSeq).values({ roomId, seq: 0n });
}

async function addMember(roomId: string, userId: string): Promise<void> {
  await getTestDb()
    .insert(roomMember)
    .values({ id: `${roomId}-${userId}`, roomId, userId, role: "member" });
}

async function upload(
  agent: request.Agent,
  roomId: string,
  filename: string,
  contentType = "text/plain",
): Promise<string> {
  const res = await agent
    .post("/api/v1/attachments")
    .field("roomId", roomId)
    .attach("file", Buffer.from("x"), { filename, contentType });
  if (res.status !== 201) {
    throw new Error(`upload failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.attachmentId;
}

describe("R12 link step — happy path + R17 inline payload", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("R12 link 3 attachments → UPDATE fires, 201 includes AttachmentPayload[]", async () => {
    const alice = await registerAgent(app, "r12-ok@example.com", "r12_ok");
    await createRoomWithSeq("r-r12-ok");
    await addMember("r-r12-ok", alice.userId);

    const a = await upload(alice.agent, "r-r12-ok", "one.txt");
    const b = await upload(alice.agent, "r-r12-ok", "two.png", "image/png");
    const c = await upload(alice.agent, "r-r12-ok", "three.bin");

    const sendRes = await alice.agent
      .post("/api/v1/rooms/r-r12-ok/messages")
      .send({ body: "with files", attachmentIds: [a, b, c] });
    expect(sendRes.status).toBe(201);
    expect(Array.isArray(sendRes.body.attachments)).toBe(true);
    expect(sendRes.body.attachments.length).toBe(3);

    const ids = new Set(
      sendRes.body.attachments.map((p: { id: string }) => p.id),
    );
    expect(ids.has(a)).toBe(true);
    expect(ids.has(b)).toBe(true);
    expect(ids.has(c)).toBe(true);

    for (const p of sendRes.body.attachments as Array<{
      id: string;
      downloadUrl: string;
    }>) {
      expect(p.downloadUrl).toBe(`/api/v1/attachments/${p.id}`);
    }

    // DB side: all three attachments have messageId = inserted message id.
    const [msgRow] = await getTestDb()
      .select({ id: message.id })
      .from(message)
      .where(eq(message.id, sendRes.body.id));
    const attRows = await getTestDb()
      .select({ id: attachment.id, messageId: attachment.messageId })
      .from(attachment)
      .where(eq(attachment.messageId, msgRow.id));
    expect(attRows.length).toBe(3);
  });

  test("R17 GET history slice carries attachments inline", async () => {
    const alice = await registerAgent(app, "r17-hist@example.com", "r17_hist");
    await createRoomWithSeq("r-r17-hist");
    await addMember("r-r17-hist", alice.userId);

    const a = await upload(alice.agent, "r-r17-hist", "pic.png", "image/png");
    await alice.agent
      .post("/api/v1/rooms/r-r17-hist/messages")
      .send({ body: "look", attachmentIds: [a] });

    const hist = await alice.agent.get("/api/v1/rooms/r-r17-hist/messages");
    expect(hist.status).toBe(200);
    const msgs = hist.body.messages as Array<{
      attachments?: Array<{ id: string; mimeType: string }>;
    }>;
    expect(msgs.length).toBe(1);
    expect(msgs[0].attachments?.length).toBe(1);
    expect(msgs[0].attachments?.[0].id).toBe(a);
    expect(msgs[0].attachments?.[0].mimeType).toBe("image/png");
  });

  test("R12 empty attachmentIds / omitted → sends normally, no attachments key", async () => {
    const alice = await registerAgent(app, "r12-none@example.com", "r12_none");
    await createRoomWithSeq("r-r12-none");
    await addMember("r-r12-none", alice.userId);

    const sendRes = await alice.agent
      .post("/api/v1/rooms/r-r12-none/messages")
      .send({ body: "plain" });
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.attachments).toBeUndefined();
  });
});

describe("R12 link step — failure branches", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("R12 attachment uploaded by a different user → 400, no message, seq unchanged", async () => {
    const alice = await registerAgent(app, "r12-alice@example.com", "r12_alice");
    const bob = await registerAgent(app, "r12-bob@example.com", "r12_bob");

    await createRoomWithSeq("r-r12-other-user");
    await addMember("r-r12-other-user", alice.userId);
    await addMember("r-r12-other-user", bob.userId);

    // Bob uploads; Alice tries to link it.
    const bobsFile = await upload(bob.agent, "r-r12-other-user", "b.txt");

    const sendRes = await alice.agent
      .post("/api/v1/rooms/r-r12-other-user/messages")
      .send({ body: "steal", attachmentIds: [bobsFile] });
    expect(sendRes.status).toBe(400);
    expect(sendRes.body).toMatchObject({ error: "attachment_invalid" });

    // No message row landed.
    const msgs = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.roomId, "r-r12-other-user"));
    expect(msgs.length).toBe(0);

    // seq did NOT advance (rollback).
    const [seq] = await getTestDb()
      .select({ seq: messageSeq.seq })
      .from(messageSeq)
      .where(eq(messageSeq.roomId, "r-r12-other-user"));
    expect(seq.seq).toBe(0n);

    // Bob's attachment row is still orphan.
    const [attRow] = await getTestDb()
      .select({ messageId: attachment.messageId })
      .from(attachment)
      .where(eq(attachment.id, bobsFile));
    expect(attRow.messageId).toBeNull();
  });

  test("R12 attachment uploaded to a different room → 400", async () => {
    const alice = await registerAgent(
      app,
      "r12-roomx@example.com",
      "r12_roomx",
    );

    await createRoomWithSeq("r-r12-roomA");
    await createRoomWithSeq("r-r12-roomB");
    await addMember("r-r12-roomA", alice.userId);
    await addMember("r-r12-roomB", alice.userId);

    const fileInA = await upload(alice.agent, "r-r12-roomA", "cross.txt");

    const sendRes = await alice.agent
      .post("/api/v1/rooms/r-r12-roomB/messages")
      .send({ body: "wrong room", attachmentIds: [fileInA] });
    expect(sendRes.status).toBe(400);
    expect(sendRes.body).toMatchObject({ error: "attachment_invalid" });

    const [seq] = await getTestDb()
      .select({ seq: messageSeq.seq })
      .from(messageSeq)
      .where(eq(messageSeq.roomId, "r-r12-roomB"));
    expect(seq.seq).toBe(0n);
  });

  test("R12 attachment already linked → 400", async () => {
    const alice = await registerAgent(
      app,
      "r12-relink@example.com",
      "r12_relink",
    );
    await createRoomWithSeq("r-r12-relink");
    await addMember("r-r12-relink", alice.userId);

    const fileId = await upload(alice.agent, "r-r12-relink", "once.txt");

    // First send succeeds.
    const first = await alice.agent
      .post("/api/v1/rooms/r-r12-relink/messages")
      .send({ body: "first", attachmentIds: [fileId] });
    expect(first.status).toBe(201);

    // Second send trying to re-link the same attachment → 400.
    const second = await alice.agent
      .post("/api/v1/rooms/r-r12-relink/messages")
      .send({ body: "second", attachmentIds: [fileId] });
    expect(second.status).toBe(400);
    expect(second.body).toMatchObject({ error: "attachment_invalid" });

    // And only the first message exists; seq is 1, not 2.
    const msgs = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.roomId, "r-r12-relink"));
    expect(msgs.length).toBe(1);
    const [seq] = await getTestDb()
      .select({ seq: messageSeq.seq })
      .from(messageSeq)
      .where(eq(messageSeq.roomId, "r-r12-relink"));
    expect(seq.seq).toBe(1n);
  });

  test("R12 unknown attachment id → 400", async () => {
    const alice = await registerAgent(app, "r12-ghost@example.com", "r12_ghost");
    await createRoomWithSeq("r-r12-ghost");
    await addMember("r-r12-ghost", alice.userId);

    const sendRes = await alice.agent
      .post("/api/v1/rooms/r-r12-ghost/messages")
      .send({ body: "phantom", attachmentIds: ["no-such-id"] });
    expect(sendRes.status).toBe(400);
    expect(sendRes.body).toMatchObject({ error: "attachment_invalid" });
  });
});
