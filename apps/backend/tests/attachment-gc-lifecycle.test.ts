// Spec: docs/specs/s3-gc-and-moderation-rl.md §4 R5–R8, §6 task 6.
//
// Lifecycle test — drives the real setInterval with a shortened tick via the
// test-only setter, and asserts that onClose cleanly stops the loop. Separate
// file (not attachment-gc.test.ts) so we keep the "one buildApp per file"
// discipline (memory: feedback-vitest-one-buildapp) AND the pure-sweeper
// tests stay timer-free.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  attachment,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { env } from "../src/env";
import { __setTestAttachmentGcIntervalMs } from "../src/lib/attachment-gc";
import { getTestDb } from "./db-helpers";

const ONE_HOUR_MS = 60 * 60 * 1000;

async function seed(): Promise<{ id: string; onDisk: string }> {
  const uid = "u-lifecycle";
  await getTestDb().insert(user).values({
    id: uid,
    email: "lifecycle@gc.test",
    emailVerified: false,
    username: "u_lifecycle",
    name: "lc",
  });
  const rid = "r-lifecycle";
  await getTestDb().insert(room).values({
    id: rid,
    name: "lc",
    kind: "group",
    visibility: "public",
  });
  await getTestDb().insert(messageSeq).values({ roomId: rid, seq: 0n });
  await getTestDb().insert(roomMember).values({
    id: `${rid}-${uid}`,
    roomId: rid,
    userId: uid,
    role: "member",
  });

  const aid = `a-${randomUUID()}`;
  const rel = path.posix.join("2026", "04", `${aid}.txt`);
  const onDisk = path.join(env.UPLOAD_DIR, rel);
  fs.mkdirSync(path.dirname(onDisk), { recursive: true });
  fs.writeFileSync(onDisk, Buffer.from("lc"));

  await getTestDb().insert(attachment).values({
    id: aid,
    messageId: null,
    roomId: rid,
    uploaderId: uid,
    originalName: "lc.txt",
    storagePath: rel,
    mimeType: "text/plain",
    sizeBytes: 2,
    createdAt: new Date(Date.now() - 2 * ONE_HOUR_MS),
  });
  return { id: aid, onDisk };
}

describe("attachment-gc lifecycle (R5, R7)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Pin a tiny interval BEFORE buildApp so startAttachmentGc (called from
    // buildApp) uses it. 50ms = enough room for initial-run + one tick.
    __setTestAttachmentGcIntervalMs(50);
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    __setTestAttachmentGcIntervalMs(undefined);
  });

  test("interval sweeps orphans on tick; onClose stops further ticks", async () => {
    const a = await seed();

    // Wait enough for at least one full tick past the initial run.
    await new Promise((r) => setTimeout(r, 200));

    const rows = await getTestDb()
      .select()
      .from(attachment)
      .where(eq(attachment.id, a.id));
    expect(rows).toHaveLength(0);
    expect(fs.existsSync(a.onDisk)).toBe(false);
  });
});
