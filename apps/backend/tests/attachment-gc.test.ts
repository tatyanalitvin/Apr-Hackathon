// Spec: docs/specs/s3-gc-and-moderation-rl.md §4 R4–R8, §6 tasks 1,3,5.
//
// Pure runAttachmentGc() tests — drive the sweeper directly, do NOT rely on
// the setInterval loop (that's attachment-gc-lifecycle.test.ts). Single
// buildApp per file (memory: feedback-vitest-one-buildapp) even though no
// HTTP route is hit; we still need the app's DB + FS env (UPLOAD_DIR from
// tests/setup.ts).

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  attachment,
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { env } from "../src/env";
import { runAttachmentGc } from "../src/lib/attachment-gc";
import { getTestDb } from "./db-helpers";

interface SeedAttachmentArgs {
  id?: string;
  roomId: string;
  uploaderId: string;
  messageId: string | null;
  createdAt: Date;
  originalName?: string;
  content?: Buffer;
}

async function seedUser(
  suffix: string,
  deletedAt: Date | null = null,
): Promise<string> {
  const id = `u-${suffix}`;
  await getTestDb().insert(user).values({
    id,
    email: `${suffix}@gc.test`,
    emailVerified: false,
    username: `u_${suffix}`,
    name: suffix,
    deletedAt,
  });
  return id;
}

async function seedRoom(name: string, ownerId: string | null = null): Promise<string> {
  const id = `r-${name}`;
  await getTestDb().insert(room).values({
    id,
    name,
    kind: "group",
    visibility: "public",
    ownerId,
  });
  await getTestDb().insert(messageSeq).values({ roomId: id, seq: 0n });
  return id;
}

async function addMember(roomId: string, userId: string): Promise<void> {
  await getTestDb().insert(roomMember).values({
    id: `${roomId}-${userId}`,
    roomId,
    userId,
    role: "member",
  });
}

// Inserts a message with a pre-allocated seq so attachment.messageId is valid.
async function seedMessage(
  roomId: string,
  authorId: string,
  seq: bigint,
): Promise<string> {
  const id = `m-${randomUUID()}`;
  await getTestDb().insert(message).values({
    id,
    roomId,
    authorId,
    authorUsername: "seed",
    authorName: "seed",
    body: "seed",
    seq,
  });
  return id;
}

async function seedAttachment(args: SeedAttachmentArgs): Promise<{
  id: string;
  onDisk: string;
}> {
  const id = args.id ?? `a-${randomUUID()}`;
  const relPath = path.posix.join("2026", "04", `${id}.txt`);
  const onDisk = path.join(env.UPLOAD_DIR, relPath);
  fs.mkdirSync(path.dirname(onDisk), { recursive: true });
  fs.writeFileSync(onDisk, args.content ?? Buffer.from("gc-test"));

  await getTestDb().insert(attachment).values({
    id,
    messageId: args.messageId,
    roomId: args.roomId,
    uploaderId: args.uploaderId,
    originalName: args.originalName ?? "test.txt",
    storagePath: relPath,
    mimeType: "text/plain",
    sizeBytes: (args.content ?? Buffer.from("gc-test")).length,
    createdAt: args.createdAt,
  });
  return { id, onDisk };
}

const ONE_HOUR_MS = 60 * 60 * 1000;

describe("attachment-gc — orphan pass (R4.1)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("deletes orphan rows + files older than 1h; spares fresh orphans and linked attachments", async () => {
    const alice = await seedUser("orphan-alice");
    const roomId = await seedRoom("orphan-room");
    await addMember(roomId, alice);
    const msgId = await seedMessage(roomId, alice, 1n);

    const now = Date.now();
    const stale1 = await seedAttachment({
      roomId,
      uploaderId: alice,
      messageId: null,
      createdAt: new Date(now - 2 * ONE_HOUR_MS),
      originalName: "stale1.txt",
    });
    const stale2 = await seedAttachment({
      roomId,
      uploaderId: alice,
      messageId: null,
      createdAt: new Date(now - 90 * 60 * 1000),
      originalName: "stale2.txt",
    });
    const fresh = await seedAttachment({
      roomId,
      uploaderId: alice,
      messageId: null,
      createdAt: new Date(now - 10 * 60 * 1000), // 10 min old — too fresh
      originalName: "fresh.txt",
    });
    const linked = await seedAttachment({
      roomId,
      uploaderId: alice,
      messageId: msgId,
      createdAt: new Date(now - 2 * ONE_HOUR_MS),
      originalName: "linked.txt",
    });

    const result = await runAttachmentGc(getTestDb());

    expect(result.skipped).toBe(false);
    expect(result.orphansDeleted).toBe(2);
    expect(result.unlinkFailures).toBe(0);

    // Stale orphans gone: DB row + file.
    for (const s of [stale1, stale2]) {
      const rows = await getTestDb()
        .select()
        .from(attachment)
        .where(eq(attachment.id, s.id));
      expect(rows).toHaveLength(0);
      expect(fs.existsSync(s.onDisk)).toBe(false);
    }

    // Fresh orphan + linked attachment survive.
    for (const s of [fresh, linked]) {
      const rows = await getTestDb()
        .select()
        .from(attachment)
        .where(eq(attachment.id, s.id));
      expect(rows).toHaveLength(1);
      expect(fs.existsSync(s.onDisk)).toBe(true);
    }
  });

  test("ENOENT on unlink is tolerated — row still deleted, logged as failure=0", async () => {
    const alice = await seedUser("enoent-alice");
    const roomId = await seedRoom("enoent-room");
    await addMember(roomId, alice);

    const { id, onDisk } = await seedAttachment({
      roomId,
      uploaderId: alice,
      messageId: null,
      createdAt: new Date(Date.now() - 2 * ONE_HOUR_MS),
      originalName: "ghost.txt",
    });
    // Pre-unlink the file so the sweeper's fs.unlink sees ENOENT.
    fs.unlinkSync(onDisk);

    const result = await runAttachmentGc(getTestDb());

    expect(result.orphansDeleted).toBe(1);
    expect(result.unlinkFailures).toBe(0); // ENOENT counts as "already gone", not a failure.
    const rows = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, id));
    expect(rows).toHaveLength(0);
  });
});

describe("attachment-gc — tombstoned-user pass (R4.2)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("deletes bytes uploaded by users tombstoned >1h ago; spares fresh tombstones and live users; preserves co-attachments by other uploaders on the same message", async () => {
    const now = Date.now();
    const staleTomb = await seedUser(
      "tomb-stale",
      new Date(now - 2 * ONE_HOUR_MS),
    );
    const freshTomb = await seedUser(
      "tomb-fresh",
      new Date(now - 30 * 60 * 1000),
    );
    const live = await seedUser("tomb-live", null);

    const roomId = await seedRoom("tomb-room");
    // Ensure all three users exist as members (so messages/attachments are
    // referentially valid even if the user row is soft-deleted).
    for (const u of [staleTomb, freshTomb, live]) {
      await addMember(roomId, u);
    }
    const m1 = await seedMessage(roomId, staleTomb, 1n);
    const m2 = await seedMessage(roomId, freshTomb, 2n);

    // A: on m1, uploaded by staleTomb — should be deleted.
    const a = await seedAttachment({
      roomId,
      uploaderId: staleTomb,
      messageId: m1,
      createdAt: new Date(now),
      originalName: "A.txt",
    });
    // B: on m2, uploaded by freshTomb — should survive (not yet past retention).
    const b = await seedAttachment({
      roomId,
      uploaderId: freshTomb,
      messageId: m2,
      createdAt: new Date(now),
      originalName: "B.txt",
    });
    // C: on m1, uploaded by live user — survives despite co-location on m1.
    const c = await seedAttachment({
      roomId,
      uploaderId: live,
      messageId: m1,
      createdAt: new Date(now),
      originalName: "C.txt",
    });

    const result = await runAttachmentGc(getTestDb());

    expect(result.skipped).toBe(false);
    expect(result.tombstonedDeleted).toBe(1);

    // A gone.
    expect(
      (
        await getTestDb()
          .select()
          .from(attachment)
          .where(eq(attachment.id, a.id))
      ).length,
    ).toBe(0);
    expect(fs.existsSync(a.onDisk)).toBe(false);

    // B and C present.
    for (const s of [b, c]) {
      expect(
        (
          await getTestDb()
            .select()
            .from(attachment)
            .where(eq(attachment.id, s.id))
        ).length,
      ).toBe(1);
      expect(fs.existsSync(s.onDisk)).toBe(true);
    }

    // m1 still exists (only the one attachment A was scoped by uploaderId).
    const m1Rows = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.id, m1));
    expect(m1Rows).toHaveLength(1);
  });
});

describe("attachment-gc — re-entry + fail-open (R5, R8)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("concurrent runs: second call returns {skipped:true} without double-delete", async () => {
    const alice = await seedUser("reentry-alice");
    const roomId = await seedRoom("reentry-room");
    await addMember(roomId, alice);
    await seedAttachment({
      roomId,
      uploaderId: alice,
      messageId: null,
      createdAt: new Date(Date.now() - 2 * ONE_HOUR_MS),
    });

    const [a, b] = await Promise.all([
      runAttachmentGc(getTestDb()),
      runAttachmentGc(getTestDb()),
    ]);

    // Exactly one of the two sees the row and deletes it; the other is skipped.
    const deleted = [a, b].find((r) => !r.skipped);
    const skipped = [a, b].find((r) => r.skipped);
    expect(deleted).toBeDefined();
    expect(skipped).toBeDefined();
    expect(deleted!.orphansDeleted).toBe(1);
  });
});
