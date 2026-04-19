// DELETE /api/v1/rooms/:roomId/messages/:messageId — REQ-112/113/114.
// Soft-delete only (brief §6 non-neg #4): body cleared to '', deletedAt set,
// attachments cascade via explicit delete. Author-only. Idempotent on re-hit.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import {
  attachment,
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { flushRedis, getTestDb } from "./db-helpers";

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
    .send({ email, username, password: "password1234", name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
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

async function sendMessage(
  agent: request.Agent,
  roomId: string,
  body: string,
): Promise<string> {
  const res = await agent
    .post(`/api/v1/rooms/${roomId}/messages`)
    .send({ body });
  if (res.status !== 201) {
    throw new Error(`send failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.id as string;
}

describe("REQ-112 DELETE /api/v1/rooms/:roomId/messages/:messageId soft-delete", () => {
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

  test("REQ-112 author deletes own message → 204 + row soft-deleted", async () => {
    const alice = await registerAgent(app, "del-a@example.com", "del_a");
    await createRoom("r-del-happy");
    await addMember("r-del-happy", alice.userId);
    const messageId = await sendMessage(alice.agent, "r-del-happy", "goodbye cruel world");

    const res = await alice.agent.delete(
      `/api/v1/rooms/r-del-happy/messages/${messageId}`,
    );
    expect(res.status).toBe(204);

    const [row] = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.id, messageId));
    // Row retained — seq continuity (brief §6 non-neg #5).
    expect(row).toBeTruthy();
    expect(row.body).toBe("");
    expect(row.deletedAt).not.toBeNull();
    expect(row.authorId).toBe(alice.userId);
    // authorName/authorUsername snapshot retained so the tombstone UI can
    // still render "Alice — [message deleted]".
    expect(row.authorName).toBe("del_a");
    expect(row.seq).toBe(1n);
  });

  test("REQ-113 delete cascades to attachment rows", async () => {
    const alice = await registerAgent(app, "del-att@example.com", "del_att");
    await createRoom("r-del-att");
    await addMember("r-del-att", alice.userId);

    const up = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-del-att")
      .attach("file", Buffer.from("att-payload"), {
        filename: "file.txt",
        contentType: "text/plain",
      });
    expect(up.status).toBe(201);
    const attId: string = up.body.attachmentId;

    const sendRes = await alice.agent
      .post("/api/v1/rooms/r-del-att/messages")
      .send({ body: "with file", attachmentIds: [attId] });
    expect(sendRes.status).toBe(201);
    const messageId: string = sendRes.body.id;

    // Sanity — attachment row links to the message before delete.
    const beforeRows = await getTestDb()
      .select({ id: attachment.id })
      .from(attachment)
      .where(eq(attachment.messageId, messageId));
    expect(beforeRows).toHaveLength(1);

    const res = await alice.agent.delete(
      `/api/v1/rooms/r-del-att/messages/${messageId}`,
    );
    expect(res.status).toBe(204);

    // Attachment row gone; message row retained with cleared body.
    const afterAtts = await getTestDb()
      .select({ id: attachment.id })
      .from(attachment)
      .where(inArray(attachment.id, [attId]));
    expect(afterAtts).toHaveLength(0);

    const [msgRow] = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.id, messageId));
    expect(msgRow).toBeTruthy();
    expect(msgRow.body).toBe("");
  });

  test("REQ-112 idempotent re-delete → 204 and deletedAt unchanged", async () => {
    const alice = await registerAgent(app, "del-idem@example.com", "del_idem");
    await createRoom("r-del-idem");
    await addMember("r-del-idem", alice.userId);
    const messageId = await sendMessage(alice.agent, "r-del-idem", "once");

    const first = await alice.agent.delete(
      `/api/v1/rooms/r-del-idem/messages/${messageId}`,
    );
    expect(first.status).toBe(204);

    const [afterFirst] = await getTestDb()
      .select({ deletedAt: message.deletedAt })
      .from(message)
      .where(eq(message.id, messageId));
    const firstDeletedAt = afterFirst.deletedAt?.toISOString();
    expect(firstDeletedAt).toBeTruthy();

    // Small wait so a bug that re-stamps would show up as a different ISO.
    await new Promise((r) => setTimeout(r, 10));

    const second = await alice.agent.delete(
      `/api/v1/rooms/r-del-idem/messages/${messageId}`,
    );
    expect(second.status).toBe(204);

    const [afterSecond] = await getTestDb()
      .select({ deletedAt: message.deletedAt })
      .from(message)
      .where(eq(message.id, messageId));
    expect(afterSecond.deletedAt?.toISOString()).toBe(firstDeletedAt);
  });

  test("REQ-114 non-author member → 403, row unchanged", async () => {
    const alice = await registerAgent(app, "del-authz-a@example.com", "del_authz_a");
    const bob = await registerAgent(app, "del-authz-b@example.com", "del_authz_b");
    await createRoom("r-del-authz");
    await addMember("r-del-authz", alice.userId);
    await addMember("r-del-authz", bob.userId);
    const messageId = await sendMessage(alice.agent, "r-del-authz", "alice text");

    const res = await bob.agent.delete(
      `/api/v1/rooms/r-del-authz/messages/${messageId}`,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "not_message_author" });

    const [row] = await getTestDb()
      .select({ body: message.body, deletedAt: message.deletedAt })
      .from(message)
      .where(eq(message.id, messageId));
    expect(row.body).toBe("alice text");
    expect(row.deletedAt).toBeNull();
  });

  test("REQ-114 non-member of the room → 403", async () => {
    const alice = await registerAgent(app, "del-nmm-a@example.com", "del_nmm_a");
    const eve = await registerAgent(app, "del-nmm-e@example.com", "del_nmm_e");
    await createRoom("r-del-nmm");
    await addMember("r-del-nmm", alice.userId);
    const messageId = await sendMessage(alice.agent, "r-del-nmm", "members only");

    const res = await eve.agent.delete(
      `/api/v1/rooms/r-del-nmm/messages/${messageId}`,
    );
    expect(res.status).toBe(403);
  });

  test("REQ-112 no cookie → 401", async () => {
    const alice = await registerAgent(app, "del-nocookie@example.com", "del_nck");
    await createRoom("r-del-nck");
    await addMember("r-del-nck", alice.userId);
    const messageId = await sendMessage(alice.agent, "r-del-nck", "hi");

    const res = await request(app.server).delete(
      `/api/v1/rooms/r-del-nck/messages/${messageId}`,
    );
    expect(res.status).toBe(401);
  });

  test("REQ-112 message in a different room → 404", async () => {
    const alice = await registerAgent(app, "del-wrongroom@example.com", "del_wr");
    await createRoom("r-del-wr-a");
    await createRoom("r-del-wr-b");
    await addMember("r-del-wr-a", alice.userId);
    await addMember("r-del-wr-b", alice.userId);
    const messageId = await sendMessage(alice.agent, "r-del-wr-a", "in A");

    const res = await alice.agent.delete(
      `/api/v1/rooms/r-del-wr-b/messages/${messageId}`,
    );
    expect(res.status).toBe(404);
  });

  test("REQ-112 history GET filters deleted messages out", async () => {
    const alice = await registerAgent(app, "del-hist@example.com", "del_hist");
    await createRoom("r-del-hist");
    await addMember("r-del-hist", alice.userId);

    const m1 = await sendMessage(alice.agent, "r-del-hist", "one");
    await sendMessage(alice.agent, "r-del-hist", "two");

    const del = await alice.agent.delete(
      `/api/v1/rooms/r-del-hist/messages/${m1}`,
    );
    expect(del.status).toBe(204);

    const hist = await alice.agent
      .get(`/api/v1/rooms/r-del-hist/messages`)
      .expect(200);
    const ids = (hist.body.messages as Array<{ id: string }>).map((m) => m.id);
    expect(ids).not.toContain(m1);
    // But roomHeadSeq advanced to the latest sent (seq continuity preserved).
    expect(hist.body.roomHeadSeq).toBe("2");
  });
});
