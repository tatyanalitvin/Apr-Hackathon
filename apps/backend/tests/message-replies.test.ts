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
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { and, eq } from "drizzle-orm";
import { sendMessageSchema } from "@ai-herders/shared/dto";
import {
  friendship,
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";
import {
  REPLY_PREVIEW_ELLIPSIS,
  REPLY_PREVIEW_MAX,
  type ClientToServerEvents,
  type MessageNewEvent,
  type MessagePayload,
  type ServerToClientEvents,
} from "@ai-herders/shared/protocol";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

type TypedClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

async function registerWithCookie(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<{ agent: request.Agent; userId: string; cookieHeader: string }> {
  const agent = request.agent(app.server);
  const res = await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: "password1234", name: username })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return { agent, userId: row.id, cookieHeader };
}

async function connectClient(
  baseUrl: string,
  cookieHeader: string,
): Promise<TypedClient> {
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

  test("REQ-110 R7 long-parent send → replyTo.text is truncated to 120 + ellipsis end-to-end", async () => {
    // R7 is unit-tested via reply-preview.test.ts (120/121/500 char cases).
    // This integration test proves the helper is wired through the send handler
    // — guarding against a future refactor that hydrates replyTo elsewhere and
    // forgets to call previewFromParent / inlines a different truncation rule.
    const { agent, userId } = await registerAgent(
      app,
      "r7-long@example.com",
      "r7_long",
    );
    await createRoom("r-r7-long");
    await addMember("r-r7-long", userId);

    // 500-char parent body — far above PREVIEW_MAX (120).
    const longBody = "abcdefghij".repeat(50);
    const parentRes = await agent
      .post("/api/v1/rooms/r-r7-long/messages")
      .send({ body: longBody });
    expect(parentRes.status).toBe(201);
    const parentId: string = parentRes.body.id;

    const res = await agent.post("/api/v1/rooms/r-r7-long/messages").send({
      body: "re: tldr",
      replyToId: parentId,
    });
    expect(res.status).toBe(201);
    expect(res.body.replyTo.text).toHaveLength(121); // 120 + U+2026
    expect(res.body.replyTo.text.endsWith("\u2026")).toBe(true);
    expect(res.body.replyTo.text.slice(0, 120)).toBe(longBody.slice(0, 120));
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

// ─── REQ-110 R5 broadcast shape (socket-level) ─────────────────────────────

describe("REQ-110 R5 message.new event carries replyTo", () => {
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

  test("REQ-110 R5 reply send emits message.new with hydrated replyTo", async () => {
    // Three agents: alice sends parent, bob sends reply, carol observes
    // via socket. Keeping the observer distinct from the senders avoids
    // the "once listener vs own-broadcast" races that timed out when the
    // reply sender was also the socket subscriber.
    const alice = await registerWithCookie(
      app,
      "r5-sock-a@example.com",
      "r5_sock_a",
    );
    const bob = await registerWithCookie(
      app,
      "r5-sock-b@example.com",
      "r5_sock_b",
    );
    const carol = await registerWithCookie(
      app,
      "r5-sock-c@example.com",
      "r5_sock_c",
    );
    await createRoom("r-r5-sock", alice.userId);
    await addMember("r-r5-sock", alice.userId);
    await addMember("r-r5-sock", bob.userId);
    await addMember("r-r5-sock", carol.userId);

    const carolClient = await connectClient(baseUrl, carol.cookieHeader);
    try {
      const subAck = await new Promise<{ ok: boolean }>((resolve) => {
        carolClient.emit("room.subscribe", "r-r5-sock", (res) => resolve(res));
      });
      expect(subAck.ok).toBe(true);

      // Collect all message.new events carol sees; pick out the reply by seq.
      const events: MessageNewEvent[] = [];
      carolClient.on("message.new", (evt) => events.push(evt));

      const parentRes = await alice.agent
        .post("/api/v1/rooms/r-r5-sock/messages")
        .send({ body: "hello team" });
      expect(parentRes.status).toBe(201);
      const parentId: string = parentRes.body.id;

      const replyRes = await bob.agent
        .post("/api/v1/rooms/r-r5-sock/messages")
        .send({ body: "re: yes", replyToId: parentId });
      expect(replyRes.status).toBe(201);

      // Wait for both events (seq=1 parent, seq=2 reply).
      const deadline = Date.now() + 2000;
      while (events.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(events).toHaveLength(2);

      const replyEvt = events.find((e) => e.message.seq === "2");
      expect(replyEvt).toBeDefined();
      expect(replyEvt!.message.replyToId).toBe(parentId);
      expect(replyEvt!.message.replyTo).toEqual({
        id: parentId,
        text: "hello team",
        authorUsername: "r5_sock_a",
        deletedAt: null,
      });

      const parentEvt = events.find((e) => e.message.seq === "1");
      expect(parentEvt!.message.replyTo).toBeNull();
    } finally {
      carolClient.close();
    }
  });

  test("REQ-110 R6 history GET hydrates replyTo for reply rows; null for non-replies", async () => {
    const { agent, userId } = await registerAgent(
      app,
      "r6-hydrate@example.com",
      "r6_hydrate",
    );
    await createRoom("r-r6-hydrate");
    await addMember("r-r6-hydrate", userId);

    // Seed 5 messages: 2 non-replies (parent P1, parent P2), 3 replies
    // (R1/R2 → P1; R3 → P2). Contract: all 5 rows returned; replies have
    // hydrated replyTo; non-replies have replyTo: null.
    const p1 = await agent
      .post("/api/v1/rooms/r-r6-hydrate/messages")
      .send({ body: "first parent" });
    const p2 = await agent
      .post("/api/v1/rooms/r-r6-hydrate/messages")
      .send({ body: "second parent" });
    const r1 = await agent
      .post("/api/v1/rooms/r-r6-hydrate/messages")
      .send({ body: "reply one", replyToId: p1.body.id });
    const r2 = await agent
      .post("/api/v1/rooms/r-r6-hydrate/messages")
      .send({ body: "reply two", replyToId: p1.body.id });
    const r3 = await agent
      .post("/api/v1/rooms/r-r6-hydrate/messages")
      .send({ body: "reply three", replyToId: p2.body.id });
    for (const res of [p1, p2, r1, r2, r3]) expect(res.status).toBe(201);

    const historyRes = await agent.get(
      "/api/v1/rooms/r-r6-hydrate/messages?fromSeq=1&toSeq=5",
    );
    expect(historyRes.status).toBe(200);
    expect(historyRes.body.messages).toHaveLength(5);

    const byId = new Map<string, MessagePayload>(
      historyRes.body.messages.map((m: MessagePayload) => [m.id, m]),
    );
    expect(byId.get(p1.body.id)!.replyTo).toBeNull();
    expect(byId.get(p2.body.id)!.replyTo).toBeNull();
    expect(byId.get(r1.body.id)!.replyTo).toEqual({
      id: p1.body.id,
      text: "first parent",
      authorUsername: "r6_hydrate",
      deletedAt: null,
    });
    expect(byId.get(r2.body.id)!.replyTo).toEqual({
      id: p1.body.id,
      text: "first parent",
      authorUsername: "r6_hydrate",
      deletedAt: null,
    });
    expect(byId.get(r3.body.id)!.replyTo).toEqual({
      id: p2.body.id,
      text: "second parent",
      authorUsername: "r6_hydrate",
      deletedAt: null,
    });
  });

  test("REQ-110 R6 history GET fires exactly one LEFT JOIN on message (no N+1)", async () => {
    // Wrap `pool.query` to capture SQL text for the history request.
    // Drizzle routes every SELECT through pool.query, so a self-join on
    // message appears in the captured SQL exactly once per call; a N+1
    // would surface as N extra SELECTs against `"message"` for parent
    // hydration. The author-deletion SELECT against `"user"` and the
    // attachment SELECT against `"attachment"` are separate existing
    // queries — we only match on `from "message"` + `left join` so the
    // assertion doesn't over-reach.
    const { pool } = await import("../src/db");
    const { agent, userId } = await registerAgent(
      app,
      "r6-sql@example.com",
      "r6_sql",
    );
    await createRoom("r-r6-sql");
    await addMember("r-r6-sql", userId);

    const parent = await agent
      .post("/api/v1/rooms/r-r6-sql/messages")
      .send({ body: "the parent" });
    await agent
      .post("/api/v1/rooms/r-r6-sql/messages")
      .send({ body: "the reply", replyToId: parent.body.id });

    const captured: string[] = [];
    const originalQuery = pool.query.bind(pool);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
      captured.push(text);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalQuery as any)(...args);
    };
    try {
      const historyRes = await agent.get(
        "/api/v1/rooms/r-r6-sql/messages?fromSeq=1&toSeq=2",
      );
      expect(historyRes.status).toBe(200);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = originalQuery;
    }

    const messageSelects = captured.filter((sql) =>
      /from\s+"message"/i.test(sql),
    );
    expect(messageSelects.length).toBeGreaterThan(0);
    const leftJoinCount = messageSelects.filter((sql) =>
      /left\s+join/i.test(sql),
    ).length;
    expect(leftJoinCount).toBe(1);
  });

  test("REQ-110 R5 non-reply send emits message.new with replyTo: null", async () => {
    const alice = await registerWithCookie(
      app,
      "r5-sock-plain-a@example.com",
      "r5_plain_a",
    );
    const bob = await registerWithCookie(
      app,
      "r5-sock-plain-b@example.com",
      "r5_plain_b",
    );
    await createRoom("r-r5-plain-sock", alice.userId);
    await addMember("r-r5-plain-sock", alice.userId);
    await addMember("r-r5-plain-sock", bob.userId);

    const bobClient = await connectClient(baseUrl, bob.cookieHeader);
    try {
      await new Promise<{ ok: boolean }>((resolve) => {
        bobClient.emit("room.subscribe", "r-r5-plain-sock", (res) =>
          resolve(res),
        );
      });
      const received = new Promise<MessageNewEvent>((resolve) => {
        bobClient.once("message.new", (evt) => resolve(evt));
      });
      const res = await alice.agent
        .post("/api/v1/rooms/r-r5-plain-sock/messages")
        .send({ body: "no quote" });
      expect(res.status).toBe(201);
      const evt = await Promise.race<MessageNewEvent>([
        received,
        new Promise<MessageNewEvent>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 2000),
        ),
      ]);
      expect(evt.message.replyToId).toBeNull();
      expect(evt.message.replyTo).toBeNull();
    } finally {
      bobClient.close();
    }
  });
});

// ─── REQ-110 R8 — DM parity ─────────────────────────────────────────────────
//
// Replies behave identically in DMs because DMs are group rooms with
// kind='dm' (ADR-0007) and the send/history/DM-list handlers all serialize
// through `toMessagePayload`. Two assertions:
//   1. Round-trip: bob replies to alice's DM message; response carries
//      populated replyTo (validates the send path hits the same code as
//      group rooms).
//   2. `GET /api/v1/dms` — lastMessage.replyTo is populated when the latest
//      message in the DM is a reply. Requires task 8 (batched parent fetch
//      in dms.ts `latestByRoom`) to pass; flagged TDD-red until then.

async function addFriendship(a: string, b: string): Promise<void> {
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await getTestDb()
    .insert(friendship)
    .values({ id: randomUUID(), userAId, userBId });
}

describe("REQ-110 R8 DM parity for replies", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-110 R8 reply in a DM room → 201 with replyTo populated (round-trip)", async () => {
    const alice = await registerAgent(app, "r8-alice@example.com", "r8_alice");
    const bob = await registerAgent(app, "r8-bob@example.com", "r8_bob");
    await addFriendship(alice.userId, bob.userId);

    const dmRes = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(dmRes.status).toBe(201);
    const roomId: string = dmRes.body.roomId;

    const parentRes = await alice.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "hi" });
    expect(parentRes.status).toBe(201);
    const parentId: string = parentRes.body.id;

    const replyRes = await bob.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "hey", replyToId: parentId });
    expect(replyRes.status).toBe(201);
    expect(replyRes.body.replyToId).toBe(parentId);
    expect(replyRes.body.replyTo).toEqual({
      id: parentId,
      text: "hi",
      authorUsername: "r8_alice",
      deletedAt: null,
    });
  });

  test("REQ-110 R8 GET /api/v1/dms → lastMessage.replyTo populated when last message is a reply", async () => {
    // Task 8 guard: dms.ts `latestByRoom` must batch-fetch parents for any
    // lastMessage row where replyToId is non-null and call previewFromParent
    // so the listing carries the same ReplyToPreview shape as the history
    // slice. Until task 8 lands this assertion fails (lastMessage.replyTo
    // stays null).
    const alice = await registerAgent(app, "r8-list-a@example.com", "r8_list_a");
    const bob = await registerAgent(app, "r8-list-b@example.com", "r8_list_b");
    await addFriendship(alice.userId, bob.userId);

    const dmRes = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(dmRes.status).toBe(201);
    const roomId: string = dmRes.body.roomId;

    const parentRes = await alice.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "hi from alice" });
    const parentId: string = parentRes.body.id;

    const replyRes = await bob.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "hey back", replyToId: parentId });
    expect(replyRes.status).toBe(201);

    const listRes = await alice.agent.get("/api/v1/dms");
    expect(listRes.status).toBe(200);
    const item = listRes.body.dms.find((d: { roomId: string }) => d.roomId === roomId);
    expect(item).toBeDefined();
    expect(item.lastMessage).not.toBeNull();
    expect(item.lastMessage.replyToId).toBe(parentId);
    // Task 8 flips this from null → populated.
    expect(item.lastMessage.replyTo).toEqual({
      id: parentId,
      text: "hi from alice",
      authorUsername: "r8_list_a",
      deletedAt: null,
    });
  });
});
