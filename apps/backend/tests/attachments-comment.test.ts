// REQ-E-UPLOAD-RESP — upload 201 body echoes the persisted `attachment.comment`
// (post-NFC; `null` for the empty-string case) so the client reflects exactly
// what was stored. Binding spec: docs/specs/s2-attachments-enhance.md §4.
//
// Cap enforcement, NFC storage, and >cap → 400 are owned by the shipped
// REQ-082 tests in attachments-upload.test.ts (500-char cap stands). This
// file asserts only the new response-shape requirement.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { attachment, user } from "@ai-herders/shared/schema";

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

async function createRoomAsOwner(
  app: FastifyInstance,
  email: string,
  username: string,
  name: string,
): Promise<SignedUpAgent & { roomId: string }> {
  const owner = await registerAgent(app, email, username);
  const res = await owner.agent.post("/api/v1/rooms").send({ name });
  if (res.status !== 201) {
    throw new Error(
      `failed to create room ${name}: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return { ...owner, roomId: res.body.id as string };
}

async function uploadWithComment(
  agent: request.Agent,
  roomId: string,
  comment: string | undefined,
  bodyBytes: Buffer = Buffer.from("hello"),
): Promise<request.Response> {
  const req = agent.post("/api/v1/attachments").field("roomId", roomId);
  if (comment !== undefined) req.field("comment", comment);
  return req.attach("file", bodyBytes, { filename: "x.txt", contentType: "text/plain" });
}

describe("REQ-E-UPLOAD-RESP — upload response echoes persisted comment", () => {
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

  test("REQ-E-UPLOAD-RESP — 201 body echoes post-NFC comment", async () => {
    const alice = await createRoomAsOwner(
      app,
      "eresp-nfc@example.com",
      "eresp_nfc",
      "ERESP NFC",
    );
    // NFD input → NFC on store. Proves the echo reflects what was persisted,
    // not the raw bytes the client sent.
    const rawNFD = "Cafe\u0301"; // "Café" decomposed.
    const res = await uploadWithComment(alice.agent, alice.roomId, rawNFD);
    expect(res.status).toBe(201);
    expect(res.body.attachmentId).toBeTruthy();
    expect(res.body.comment).toBe(rawNFD.normalize("NFC"));

    const [row] = await getTestDb()
      .select({ comment: attachment.comment })
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    expect(row?.comment).toBe(rawNFD.normalize("NFC"));
  });

  test("REQ-E-UPLOAD-RESP — empty-string comment echoes as null", async () => {
    const alice = await createRoomAsOwner(
      app,
      "eresp-empty@example.com",
      "eresp_empty",
      "ERESP EMPTY",
    );
    const res = await uploadWithComment(alice.agent, alice.roomId, "");
    expect(res.status).toBe(201);
    expect(res.body.comment).toBeNull();
  });

  test("REQ-E-UPLOAD-RESP — no comment field → null on response", async () => {
    const alice = await createRoomAsOwner(
      app,
      "eresp-absent@example.com",
      "eresp_absent",
      "ERESP ABSENT",
    );
    const res = await uploadWithComment(alice.agent, alice.roomId, undefined);
    expect(res.status).toBe(201);
    expect(res.body.comment).toBeNull();
  });

  test("REQ-E-UPLOAD-RESP — comment round-trips via message payload", async () => {
    const alice = await createRoomAsOwner(
      app,
      "eresp-rt@example.com",
      "eresp_rt",
      "ERESP RT",
    );
    const caption = "see bottom of page 3";
    const up = await uploadWithComment(
      alice.agent,
      alice.roomId,
      caption,
      Buffer.from("pdf bytes"),
    );
    expect(up.status).toBe(201);
    expect(up.body.comment).toBe(caption);

    const send = await alice.agent
      .post(`/api/v1/rooms/${alice.roomId}/messages`)
      .send({ body: "📎 check this", attachmentIds: [up.body.attachmentId] });
    expect(send.status).toBe(201);

    const history = await alice.agent.get(
      `/api/v1/rooms/${alice.roomId}/messages`,
    );
    expect(history.status).toBe(200);
    const msg = history.body.messages.find(
      (m: { id: string; attachments?: Array<{ id: string; comment: string | null }> }) =>
        m.attachments?.some((a) => a.id === up.body.attachmentId),
    );
    expect(msg).toBeTruthy();
    const att = msg.attachments.find(
      (a: { id: string; comment: string | null }) => a.id === up.body.attachmentId,
    );
    expect(att.comment).toBe(caption);
  });
});
