// R13 / R15 — cascade + DM-freeze hold points.
// Binding spec: docs/specs/s2-attachments.md §4 R13, R15, ADR-0006.
//
// R15: hard-delete the `room` row, assert `attachment` row cascaded (FK is
// onDelete: cascade in schema.ts). XFAIL the "file on disk is gone" half —
// deleting the bytes is owned by s2-rooms.md's delete-room endpoint, not by
// this spec (§7 follow-ups).
//
// R13: DM-freeze gates attachment-bearing sends, same as plain sends. This
// test is test.skip until `apps/backend/src/lib/dm-freeze.ts` lands (owned
// by s2-dms.md). Skip marker uses the filename `dm-freeze.ts` so a reader
// can grep for the handoff point.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  attachment,
  friendship,
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { env } from "../src/env";
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
    .send({ email, username, password: "password1234", name: username })
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
  await getTestDb().insert(messageSeq).values({ roomId, seq: 0n });
}

async function addMember(roomId: string, userId: string): Promise<void> {
  await getTestDb()
    .insert(roomMember)
    .values({ id: `${roomId}-${userId}`, roomId, userId, role: "member" });
}

async function addFriendship(a: string, b: string): Promise<void> {
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await getTestDb()
    .insert(friendship)
    .values({ id: randomUUID(), userAId, userBId });
}

async function removeFriendship(a: string, b: string): Promise<void> {
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await getTestDb()
    .delete(friendship)
    .where(
      and(eq(friendship.userAId, userAId), eq(friendship.userBId, userBId)),
    );
}

describe("R15 cascade on room delete", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("R15 DELETE room → attachment row cascades (FK onDelete: cascade)", async () => {
    const alice = await registerAgent(
      app,
      "r15-cascade@example.com",
      "r15_cascade",
    );
    await createRoomWithSeq("r-r15");
    await addMember("r-r15", alice.userId);

    const up = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", "r-r15")
      .attach("file", Buffer.from("cascade-proof"), {
        filename: "c.txt",
        contentType: "text/plain",
      });
    expect(up.status).toBe(201);
    const attId: string = up.body.attachmentId;

    // Link via a send so we have both orphan-side coverage AND the
    // message-cascade half. Also confirms messageId FK is cascade:
    // deleting the room deletes messages, which cascade to attachments.
    const sendRes = await alice.agent
      .post("/api/v1/rooms/r-r15/messages")
      .send({ body: "linked", attachmentIds: [attId] });
    expect(sendRes.status).toBe(201);

    // Sanity: row + file exist before delete.
    const [before] = await getTestDb()
      .select({ storagePath: attachment.storagePath })
      .from(attachment)
      .where(eq(attachment.id, attId));
    const onDisk = path.join(env.UPLOAD_DIR, before.storagePath);
    expect(fs.existsSync(onDisk)).toBe(true);

    // s2-rooms.md owns the delete-room endpoint; direct DB delete is the
    // approved contract stand-in (R15 explicit).
    await getTestDb().delete(room).where(eq(room.id, "r-r15"));

    // DB side: attachment + message rows are gone (onDelete: cascade on both
    // attachment.messageId and attachment.roomId FKs — either alone would
    // suffice; belt-and-braces).
    const attRows = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, attId));
    expect(attRows.length).toBe(0);
    const msgRows = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.roomId, "r-r15"));
    expect(msgRows.length).toBe(0);
  });

  test.fails(
    "R15 XFAIL — file bytes on disk survive room delete (owned by s2-rooms.md)",
    async () => {
      // Explicit XFAIL so the handoff to s2-rooms.md is visible. When
      // s2-rooms.md wires its delete-room endpoint to unlink the on-disk
      // files, flip this to a regular test.
      const alice = await registerAgent(
        app,
        "r15-xfail@example.com",
        "r15_xfail",
      );
      await createRoomWithSeq("r-r15-xfail");
      await addMember("r-r15-xfail", alice.userId);

      const up = await alice.agent
        .post("/api/v1/attachments")
        .field("roomId", "r-r15-xfail")
        .attach("file", Buffer.from("still here"), {
          filename: "x.txt",
          contentType: "text/plain",
        });
      const attId: string = up.body.attachmentId;

      const [row] = await getTestDb()
        .select({ storagePath: attachment.storagePath })
        .from(attachment)
        .where(eq(attachment.id, attId));
      const onDisk = path.join(env.UPLOAD_DIR, row.storagePath);

      await getTestDb().delete(room).where(eq(room.id, "r-r15-xfail"));

      // The expected-future assertion: `existsSync` should be false. Today
      // it's still true — the DB cascade doesn't reach the filesystem.
      expect(fs.existsSync(onDisk)).toBe(false);
    },
  );
});

describe("R13 DM-freeze hold points", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // R13 — DM-freeze gates attachment-bearing sends identically to plain
  // sends. Upload itself is NOT gated (scratch-pad semantics — the row
  // goes in with messageId=NULL either way and gets GC'd if never linked).
  // The send handler consults `isDmFrozen` BEFORE seq allocation and
  // before the attachment link tx, so on a frozen DM the attachment row
  // must retain messageId=NULL, messageSeq must not advance, and no
  // message row is created.
  test("REQ-066 R13 freeze blocks attachment-bearing send on DM room", async () => {
    const alice = await registerAgent(
      app,
      "r13-dmfreeze-a@example.com",
      "r13_dmfreeze_a",
    );
    const bob = await registerAgent(
      app,
      "r13-dmfreeze-b@example.com",
      "r13_dmfreeze_b",
    );
    await addFriendship(alice.userId, bob.userId);

    const createRes = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(createRes.status).toBe(201);
    const roomId = createRes.body.roomId as string;

    // Break the friendship — the DM is now frozen (reason: not_friends).
    await removeFriendship(alice.userId, bob.userId);

    // Upload still succeeds — scratch-pad semantics, R13 does not gate
    // the upload itself (only the link + send).
    const up = await alice.agent
      .post("/api/v1/attachments")
      .field("roomId", roomId)
      .attach("file", Buffer.from("frozen-upload"), {
        filename: "f.txt",
        contentType: "text/plain",
      });
    expect(up.status).toBe(201);
    const attId: string = up.body.attachmentId;

    // Send referencing the uploaded attachment → 409 dialog_frozen.
    const send = await alice.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "frozen-send", attachmentIds: [attId] });
    expect(send.status).toBe(409);
    expect(send.body).toMatchObject({ error: "dialog_frozen" });

    // Seq did not advance — freeze check returns BEFORE seq allocation.
    const [seqRow] = await getTestDb()
      .select({ seq: messageSeq.seq })
      .from(messageSeq)
      .where(eq(messageSeq.roomId, roomId));
    expect(seqRow!.seq).toBe(0n);

    // Attachment row still orphan (messageId=NULL) — the link tx never ran.
    const [attRow] = await getTestDb()
      .select({ messageId: attachment.messageId })
      .from(attachment)
      .where(eq(attachment.id, attId));
    expect(attRow!.messageId).toBeNull();

    // No message row was created for this room.
    const msgs = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.roomId, roomId));
    expect(msgs).toHaveLength(0);
  });
});
