// Spec: docs/specs/s3-gc-and-moderation-rl.md §4 R4–R8.
//
// Two-pass sweeper:
//   R4.1 orphans     — rows with messageId IS NULL older than retention
//   R4.2 tombstoned  — rows whose uploader was soft-deleted > retention ago
//
// Re-entry guard (R5): module-level `running` flag short-circuits overlapping
// runs. Fail-open (R8): ENOENT on unlink is "already gone", not a failure.
// We DELETE with `AND messageId IS NULL` on the orphan pass as a belt-and-
// suspenders race guard against a link landing between SELECT and DELETE.

import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull, lt } from "drizzle-orm";
import { attachment, user } from "@ai-herders/shared/schema";

import { db, type Database } from "../db";
import { env } from "../env";

export interface GcResult {
  orphansDeleted: number;
  tombstonedDeleted: number;
  unlinkFailures: number;
  skipped: boolean;
}

export const ORPHAN_RETENTION_SECONDS = 60 * 60; // 1h
export const TOMBSTONE_RETENTION_SECONDS = 60 * 60; // 1h
export const ATTACHMENT_GC_INTERVAL_MS = 15 * 60 * 1000; // 15 min

let running = false;

async function unlinkStoragePath(
  storagePath: string,
  logger: FastifyInstance["log"] | undefined,
): Promise<boolean> {
  const full = path.join(env.UPLOAD_DIR, storagePath);
  try {
    await fs.unlink(full);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return true;
    logger?.warn({ err, storagePath }, "attachment-gc: unlink failed");
    return false;
  }
}

export async function runAttachmentGc(
  db: Database,
  opts?: { logger?: FastifyInstance["log"] },
): Promise<GcResult> {
  if (running) {
    return {
      orphansDeleted: 0,
      tombstonedDeleted: 0,
      unlinkFailures: 0,
      skipped: true,
    };
  }
  running = true;
  const logger = opts?.logger;
  try {
    let orphansDeleted = 0;
    let tombstonedDeleted = 0;
    let unlinkFailures = 0;

    const orphanCutoff = new Date(Date.now() - ORPHAN_RETENTION_SECONDS * 1000);
    const orphans = await db
      .select({ id: attachment.id, storagePath: attachment.storagePath })
      .from(attachment)
      .where(
        and(isNull(attachment.messageId), lt(attachment.createdAt, orphanCutoff)),
      );

    for (const row of orphans) {
      const ok = await unlinkStoragePath(row.storagePath, logger);
      if (!ok) unlinkFailures++;
      const deleted = await db
        .delete(attachment)
        .where(and(eq(attachment.id, row.id), isNull(attachment.messageId)))
        .returning({ id: attachment.id });
      if (deleted.length > 0) orphansDeleted++;
    }

    const tombCutoff = new Date(
      Date.now() - TOMBSTONE_RETENTION_SECONDS * 1000,
    );
    const tombstoned = await db
      .select({ id: attachment.id, storagePath: attachment.storagePath })
      .from(attachment)
      .innerJoin(user, eq(user.id, attachment.uploaderId))
      .where(lt(user.deletedAt, tombCutoff));

    for (const row of tombstoned) {
      const ok = await unlinkStoragePath(row.storagePath, logger);
      if (!ok) unlinkFailures++;
      const deleted = await db
        .delete(attachment)
        .where(eq(attachment.id, row.id))
        .returning({ id: attachment.id });
      if (deleted.length > 0) tombstonedDeleted++;
    }

    return { orphansDeleted, tombstonedDeleted, unlinkFailures, skipped: false };
  } finally {
    running = false;
  }
}

// Test-only escape hatch — mirrors __setTestRateLimitGlobalMax in app.ts.
// Production always reads ATTACHMENT_GC_INTERVAL_MS; tests pin a small value
// BEFORE calling buildApp() to exercise the interval without waiting 15min.
let __testIntervalMs: number | undefined;
export function __setTestAttachmentGcIntervalMs(ms: number | undefined): void {
  __testIntervalMs = ms;
}

export function startAttachmentGc(app: FastifyInstance): void {
  const intervalMs = __testIntervalMs ?? ATTACHMENT_GC_INTERVAL_MS;

  const tick = async (): Promise<void> => {
    const start = Date.now();
    try {
      const result = await runAttachmentGc(db, { logger: app.log });
      app.log.info(
        { ...result, durationMs: Date.now() - start },
        "attachment-gc tick",
      );
    } catch (err) {
      app.log.warn({ err }, "attachment-gc tick threw");
    }
  };

  // Initial run so a freshly-booted backend doesn't wait an interval before
  // its first sweep. Fire-and-forget — awaiting would block buildApp().
  void tick();

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  // Don't keep the event loop alive just for the sweeper — the Fastify HTTP
  // server is the app's liveness anchor.
  handle.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(handle);
  });
}
