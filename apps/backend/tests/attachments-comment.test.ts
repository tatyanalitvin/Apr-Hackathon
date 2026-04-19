// REQ-E-COMMENT-CAP / REQ-E-UPLOAD-RESP — optional attachment comment.
// Binding spec: docs/specs/s2-attachments-enhance.md §4, §6.
//
// Covers:
//   - 280 UTF-16 code-unit cap (lowered from the shipped 500 in s2-attachments.md).
//   - 201 upload response echoes the persisted `comment` field.
//   - Empty-string coerces to NULL (regression guard around the existing branch).
//   - Comment round-trips through the message-payload (already wired in
//     routes/messages.ts `loadAttachmentPayloads`; regression guard).

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

describe("REQ-E-COMMENT-CAP / REQ-E-UPLOAD-RESP — attachment comment wiring", () => {
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

  test("REQ-E-UPLOAD-RESP — 201 body includes `comment` echoing persisted NFC value", async () => {
    const alice = await createRoomAsOwner(
      app,
      "ecap-ok@example.com",
      "ecap_ok",
      "ECAP OK",
    );
    // Compose a string whose NFC form differs from its NFD input — proves the
    // echo reflects post-normalisation state, not the raw bytes.
    const rawNFD = "Cafe\u0301"; // "Café" as C + \u0301 combining acute.
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

  test("REQ-E-COMMENT-CAP — 280-char comment accepted", async () => {
    const alice = await createRoomAsOwner(
      app,
      "ecap-280@example.com",
      "ecap_280",
      "ECAP 280",
    );
    const comment = "a".repeat(280);
    const res = await uploadWithComment(alice.agent, alice.roomId, comment);
    expect(res.status).toBe(201);
    expect(res.body.comment).toBe(comment);
  });

  test("REQ-E-COMMENT-CAP — 281-char comment rejected with comment_too_long", async () => {
    const alice = await createRoomAsOwner(
      app,
      "ecap-281@example.com",
      "ecap_281",
      "ECAP 281",
    );
    const comment = "a".repeat(281);
    const countBefore = (
      await getTestDb().select({ id: attachment.id }).from(attachment)
    ).length;

    const res = await uploadWithComment(alice.agent, alice.roomId, comment);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("comment_too_long");

    const countAfter = (
      await getTestDb().select({ id: attachment.id }).from(attachment)
    ).length;
    expect(countAfter).toBe(countBefore);
  });

  test("REQ-E-COMMENT-CAP — empty-string comment stored as NULL", async () => {
    const alice = await createRoomAsOwner(
      app,
      "ecap-empty@example.com",
      "ecap_empty",
      "ECAP EMPTY",
    );
    const res = await uploadWithComment(alice.agent, alice.roomId, "");
    expect(res.status).toBe(201);
    expect(res.body.comment).toBeNull();

    const [row] = await getTestDb()
      .select({ comment: attachment.comment })
      .from(attachment)
      .where(eq(attachment.id, res.body.attachmentId));
    expect(row?.comment).toBeNull();
  });

  test("REQ-E-COMMENT-CAP — comment round-trips through message payload", async () => {
    const alice = await createRoomAsOwner(
      app,
      "ecap-rt@example.com",
      "ecap_rt",
      "ECAP RT",
    );
    const caption = "see bottom of page 3";
    const up = await uploadWithComment(
      alice.agent,
      alice.roomId,
      caption,
      Buffer.from("pdf bytes"),
    );
    expect(up.status).toBe(201);

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
