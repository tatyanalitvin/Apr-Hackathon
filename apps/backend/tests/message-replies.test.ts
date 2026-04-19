// REQ-110 (parent validation / history hydration / payload shape / DM parity)
// REQ-133 (reply composer)
// Binding spec: docs/specs/s2-replies.md.
//
// This file grows through tasks 1–9 of the spec's §6. Task 1 lands the zod
// R1 assertions + a type-shape sanity check on MessagePayload.replyTo.
// Tasks 3–9 append integration tests for send validation, history hydration,
// truncation, DM parity, edit/delete pass-through, dedup invariants.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { sendMessageSchema } from "@ai-herders/shared/dto";
import {
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";
import {
  REPLY_PREVIEW_ELLIPSIS,
  REPLY_PREVIEW_MAX,
  type MessagePayload,
} from "@ai-herders/shared/protocol";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

async function registerAgent(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<{ agent: request.Agent; userId: string }> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: "password1234", name: username })
    .expect(200);
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return { agent, userId: row.id };
}

async function createRoom(
  roomId: string,
  ownerId: string | null = null,
): Promise<void> {
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
  await getTestDb().insert(roomMember).values({
    id: `${roomId}-${userId}`,
    roomId,
    userId,
    role: "member",
  });
}

describe("REQ-133 sendMessageSchema.replyToId — R1 UUID tightening", () => {
  test("REQ-133 R1 accepts omitted replyToId", () => {
    expect(sendMessageSchema.safeParse({ body: "hi" }).success).toBe(true);
  });

  test("REQ-133 R1 accepts a valid v4 UUID", () => {
    const result = sendMessageSchema.safeParse({
      body: "hi",
      replyToId: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(result.success).toBe(true);
  });

  test("REQ-133 R1 rejects a non-UUID string", () => {
    const result = sendMessageSchema.safeParse({
      body: "hi",
      replyToId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The validation issue must point at `replyToId` so the FE can surface a
      // field-specific error instead of a generic 400.
      const issuePaths = result.error.issues.map((i) => i.path.join("."));
      expect(issuePaths).toContain("replyToId");
    }
  });

  test("REQ-133 R1 rejects empty string replyToId (caught by uuid guard)", () => {
    expect(
      sendMessageSchema.safeParse({ body: "hi", replyToId: "" }).success,
    ).toBe(false);
  });
});

describe("REQ-110 protocol — R5 MessagePayload.replyTo wire shape", () => {
  test("REQ-110 R5 MessagePayload.replyTo is optional-but-present (null when absent)", () => {
    // Type-level compile check + a structural smoke: construct a payload both
    // with and without replyTo and assert the field is part of the shape.
    const withoutReply: MessagePayload = {
      id: "m1",
      roomId: "r1",
      authorId: "u1",
      authorUsername: "alice",
      authorName: "Alice",
      body: "hi",
      seq: "1",
      replyToId: null,
      replyTo: null,
      editedAt: null,
      deletedAt: null,
      createdAt: "2026-04-19T00:00:00.000Z",
    };
    const withReply: MessagePayload = {
      ...withoutReply,
      id: "m2",
      seq: "2",
      replyToId: "m1",
      replyTo: {
        id: "m1",
        text: "hi",
        authorUsername: "alice",
        deletedAt: null,
      },
    };
    expect(withoutReply.replyTo).toBeNull();
    expect(withReply.replyTo?.id).toBe("m1");
    expect(withReply.replyTo?.text).toBe("hi");
    expect(withReply.replyTo?.authorUsername).toBe("alice");
    expect(withReply.replyTo?.deletedAt).toBeNull();
  });

  test("REQ-110 R7 preview truncation constants exported from protocol", () => {
    expect(REPLY_PREVIEW_MAX).toBe(120);
    expect(REPLY_PREVIEW_ELLIPSIS).toBe("\u2026");
  });
});

// ─── REQ-110 send-path integration (R2, R3, R4, R5, R16, R17) ───────────────

describe("REQ-110 send-path parent validation", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-110 R2 parent-not-found → 400 reply_parent_invalid; no seq consumed", async () => {
    const { agent, userId } = await registerAgent(
      app,
      "r2-missing@example.com",
      "r2_missing",
    );
    await createRoom("r-r2-missing");
    await addMember("r-r2-missing", userId);

    const res = await agent.post("/api/v1/rooms/r-r2-missing/messages").send({
      body: "re: ghost",
      replyToId: randomUUID(),
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "reply_parent_invalid" });

    const [seqRow] = await getTestDb()
      .select({ seq: messageSeq.seq })
      .from(messageSeq)
      .where(eq(messageSeq.roomId, "r-r2-missing"));
    expect(seqRow.seq).toBe(0n);

    const rows = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.roomId, "r-r2-missing"));
    expect(rows).toHaveLength(0);
  });

  test("REQ-110 R3a cross-room parent (other group) → 400 reply_parent_invalid", async () => {
    const { agent, userId } = await registerAgent(
      app,
      "r3a-caller@example.com",
      "r3a_caller",
    );
    const { agent: otherAgent, userId: otherId } = await registerAgent(
      app,
      "r3a-other@example.com",
      "r3a_other",
    );
    await createRoom("r-r3a-home");
    await addMember("r-r3a-home", userId);
    await createRoom("r-r3a-away");
    await addMember("r-r3a-away", otherId);

    const parentRes = await otherAgent
      .post("/api/v1/rooms/r-r3a-away/messages")
      .send({ body: "in the other room" });
    expect(parentRes.status).toBe(201);
    const parentId: string = parentRes.body.id;

    const res = await agent.post("/api/v1/rooms/r-r3a-home/messages").send({
      body: "cross-room attempt",
      replyToId: parentId,
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "reply_parent_invalid" });
  });

  test("REQ-110 R3b parent in DM caller is NOT in → 400 reply_parent_invalid (no oracle)", async () => {
    // Two users not friends with caller; they DM each other. Caller tries
    // to reply to a parent whose id they somehow learned. Same error code
    // as "not found" — do NOT leak a "forbidden" oracle.
    const { userId: dmUserAId } = await registerAgent(
      app,
      "r3b-dma@example.com",
      "r3b_dma",
    );
    const { userId: dmUserBId } = await registerAgent(
      app,
      "r3b-dmb@example.com",
      "r3b_dmb",
    );
    const { agent: callerAgent, userId: callerId } = await registerAgent(
      app,
      "r3b-caller@example.com",
      "r3b_caller",
    );

    // Create a DM room A<->B out-of-band (not via API, since DM creation
    // requires friendship). We just need a row with kind='dm' containing a
    // parent message; caller is NOT a member.
    await getTestDb().insert(room).values({
      id: "r-r3b-dm",
      name: "dm",
      kind: "dm",
      visibility: "private",
      ownerId: null,
    });
    await getTestDb().insert(messageSeq).values({ roomId: "r-r3b-dm", seq: 0n });
    await getTestDb().insert(roomMember).values([
      { id: `r-r3b-dm-${dmUserAId}`, roomId: "r-r3b-dm", userId: dmUserAId, role: "member" },
      { id: `r-r3b-dm-${dmUserBId}`, roomId: "r-r3b-dm", userId: dmUserBId, role: "member" },
    ]);
    const parentId = randomUUID();
    await getTestDb().insert(message).values({
      id: parentId,
      roomId: "r-r3b-dm",
      authorId: dmUserAId,
      authorUsername: "r3b_dma",
      authorName: "r3b_dma",
      body: "private between us",
      seq: 1n,
    });

    // Caller has their own group room where they try the reply.
    await createRoom("r-r3b-home");
    await addMember("r-r3b-home", callerId);

    const res = await callerAgent.post("/api/v1/rooms/r-r3b-home/messages").send({
      body: "stolen id",
      replyToId: parentId,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "reply_parent_invalid" });
  });

  test("REQ-110 R3c same-room parent → 201 with replyTo populated", async () => {
    const { agent, userId } = await registerAgent(
      app,
      "r3c@example.com",
      "r3c_happy",
    );
    await createRoom("r-r3c-same");
    await addMember("r-r3c-same", userId);

    const parentRes = await agent
      .post("/api/v1/rooms/r-r3c-same/messages")
      .send({ body: "hello team" });
    expect(parentRes.status).toBe(201);
    const parentId: string = parentRes.body.id;

    const res = await agent.post("/api/v1/rooms/r-r3c-same/messages").send({
      body: "re: yes",
      replyToId: parentId,
    });
    expect(res.status).toBe(201);
    expect(res.body.replyToId).toBe(parentId);
    expect(res.body.replyTo).toEqual({
      id: parentId,
      text: "hello team",
      authorUsername: "r3c_happy",
      deletedAt: null,
    });
  });

  test("REQ-110 R4 deleted parent (contract-only) → 201 with replyTo.deletedAt non-null, text empty", async () => {
    const { agent, userId } = await registerAgent(
      app,
      "r4@example.com",
      "r4_delparent",
    );
    await createRoom("r-r4-del");
    await addMember("r-r4-del", userId);

    const parentRes = await agent
      .post("/api/v1/rooms/r-r4-del/messages")
      .send({ body: "im doomed" });
    expect(parentRes.status).toBe(201);
    const parentId: string = parentRes.body.id;

    const delRes = await agent.delete(
      `/api/v1/rooms/r-r4-del/messages/${parentId}`,
    );
    expect(delRes.status).toBe(204);

    const res = await agent.post("/api/v1/rooms/r-r4-del/messages").send({
      body: "replying to the ghost",
      replyToId: parentId,
    });
    expect(res.status).toBe(201);
    expect(res.body.replyToId).toBe(parentId);
    expect(res.body.replyTo.id).toBe(parentId);
    expect(res.body.replyTo.text).toBe("");
    expect(res.body.replyTo.deletedAt).not.toBeNull();
    expect(typeof res.body.replyTo.deletedAt).toBe("string");
  });

  test("REQ-110 R5 non-reply send → response has replyTo: null (key present)", async () => {
    const { agent, userId } = await registerAgent(
      app,
      "r5-nonreply@example.com",
      "r5_nonreply",
    );
    await createRoom("r-r5-plain");
    await addMember("r-r5-plain", userId);

    const res = await agent
      .post("/api/v1/rooms/r-r5-plain/messages")
      .send({ body: "no quote" });
    expect(res.status).toBe(201);
    expect(Object.prototype.hasOwnProperty.call(res.body, "replyTo")).toBe(true);
    expect(res.body.replyTo).toBeNull();
    expect(res.body.replyToId).toBeNull();
  });

  test("REQ-110 R16 idempotency with replyToId → same row returned, replyTo preserved", async () => {
    const { agent, userId } = await registerAgent(
      app,
      "r16@example.com",
      "r16_idem",
    );
    await createRoom("r-r16-idem");
    await addMember("r-r16-idem", userId);

    const parentRes = await agent
      .post("/api/v1/rooms/r-r16-idem/messages")
      .send({ body: "parent" });
    const parentId: string = parentRes.body.id;

    const clientMessageId = randomUUID();
    const first = await agent.post("/api/v1/rooms/r-r16-idem/messages").send({
      body: "first attempt",
      replyToId: parentId,
      clientMessageId,
    });
    expect(first.status).toBe(201);
    expect(first.body.replyTo.id).toBe(parentId);

    const second = await agent.post("/api/v1/rooms/r-r16-idem/messages").send({
      body: "second attempt (should be ignored)",
      replyToId: parentId,
      clientMessageId,
    });
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.seq).toBe(first.body.seq);
    expect(second.body.replyTo.id).toBe(parentId);

    const rows = await getTestDb()
      .select({ id: message.id })
      .from(message)
      .where(
        and(
          eq(message.roomId, "r-r16-idem"),
          eq(message.replyToId, parentId),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  test("REQ-110 R1/R2 malformed UUID replyToId → 400 validation (zod guard)", async () => {
    // R1 boundary — zod rejects before the handler runs; error shape is
    // the generic validation envelope, NOT reply_parent_invalid.
    const { agent, userId } = await registerAgent(
      app,
      "r1-boundary@example.com",
      "r1_boundary",
    );
    await createRoom("r-r1-bound");
    await addMember("r-r1-bound", userId);

    const res = await agent.post("/api/v1/rooms/r-r1-bound/messages").send({
      body: "hi",
      replyToId: "not-a-uuid",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation");
  });
});
