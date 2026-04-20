// REQ-075/077/078/079/081/082/083 — attachment upload + download endpoints.
//
// Two-step flow: client POSTs the file (orphan attachment row, messageId NULL)
// then references the returned id in `attachmentIds` on the next message send
// (linked inside the existing transaction at routes/messages.ts).
//
// Auth runs ahead of multipart parsing so a missing session returns 401
// without draining a (possibly large) request body. Membership is checked
// AFTER the multipart fields are read because roomId arrives in the body —
// when it fails we drain the file stream so the client connection terminates
// cleanly.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { and, eq } from "drizzle-orm";
import { attachment, roomBan, roomMember } from "@ai-herders/shared/schema";

import { auth } from "../auth";
import { db } from "../db";
import { toFetchHeaders } from "../lib/fetch-headers";
import {
  buildStoragePath,
  resolveStorageAbsolute,
} from "../lib/attachment-storage";

const FILE_CAP_BYTES = 20 * 1024 * 1024;
const IMAGE_CAP_BYTES = 3 * 1024 * 1024;
const COMMENT_MAX = 500;

// MIME allowlist — defense-in-depth per handler-level security pass. The
// original spec (s2-attachments.md §REQ-075) is "arbitrary types, no allowlist;
// executable deny-list deferred to S3". We keep the policy tight: images +
// common documents + generic binary + a small media set. `application/
// octet-stream` stays in the allowlist because legitimate clients send it for
// unknown binary content (and the existing REQ-075 integration test covers
// the .exe-as-octet-stream case — we still accept it; safety lives in the
// download path's forced `Content-Disposition: attachment`, not the upload
// gate). A rejection is reported with 415 + `attachment_mime_unsupported`.
const ALLOWED_MIME_TYPES = new Set<string>([
  // Images
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  // Documents
  "application/pdf",
  "text/plain",
  "application/zip",
  // Media
  "video/mp4",
  "audio/mpeg",
  "audio/wav",
  // Generic binary — the REQ-075 regression test leans on this; client-
  // provided octet-stream is passed through as-is because the download path's
  // `Content-Disposition: attachment` is the real safety net (R11).
  "application/octet-stream",
]);

function drain(stream: NodeJS.ReadableStream): void {
  // Best-effort: if the multipart stream is left unconsumed the request hangs
  // on the client side until idle timeout. Resume() ditches the bytes; the
  // plugin still tears down the connection cleanly.
  stream.resume();
}

// Sentinel error codes thrown from the stream listener so the outer pipeline
// rejection can distinguish a deliberate cap-abort from a real I/O failure.
const ERR_IMAGE_CAP = "E_IMAGE_CAP";
const ERR_FILE_CAP = "E_FILE_CAP";

export async function attachmentsRoutes(app: FastifyInstance): Promise<void> {
  // REQ-147 — 30/min/IP upload cap. Each upload can be up to 20 MB and
  // writes to the local-FS volume; unbounded uploads are the easiest DoS
  // vector on the attachment surface. 30/min leaves plenty of headroom
  // for drag-drop-burst UX (dragging five pictures in quick succession)
  // while clamping bulk-fuzzer behavior.
  app.post(
    "/",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const headers = toFetchHeaders(request);
      const session = await auth.api.getSession({ headers });
      if (!session) {
        return reply.status(401).send({ error: "unauthorized" });
      }
      const userId = session.user.id;

      let data: Awaited<ReturnType<FastifyRequest["file"]>>;
      try {
        data = await request.file();
      } catch (err) {
        // The multipart plugin throws when the request lacks a multipart
        // content-type (typed as MB_ERR_INVALID_MULTIPART_CONTENT_TYPE) or
        // when limits are exceeded synchronously. Treat as 400.
        request.log.warn({ err }, "attachment multipart parse failed");
        return reply.status(400).send({ error: "invalid_multipart" });
      }

      if (!data) {
        return reply.status(400).send({ error: "missing_file" });
      }

      const fields = data.fields as Record<
        string,
        { value?: unknown } | undefined
      >;
      const roomIdField = fields.roomId?.value;
      if (typeof roomIdField !== "string" || roomIdField.length === 0) {
        drain(data.file);
        return reply.status(400).send({ error: "missing_room_id" });
      }
      const roomId = roomIdField;

      const [membership] = await db
        .select({ id: roomMember.id })
        .from(roomMember)
        .where(
          and(eq(roomMember.roomId, roomId), eq(roomMember.userId, userId)),
        )
        .limit(1);
      if (!membership) {
        drain(data.file);
        // Same 403-as-oracle-suppression rationale as message-auth.
        return reply.status(403).send({ error: "forbidden" });
      }

      // Mirror the download path's gate: reject if a ban row exists for this
      // (room, user), even with membership present. Ban-apply in rooms.ts
      // deletes membership in the same tx so in practice the !membership
      // branch catches bans today — this is defense-in-depth for any future
      // ban flow that defers membership GC.
      const [ban] = await db
        .select({ id: roomBan.id })
        .from(roomBan)
        .where(and(eq(roomBan.roomId, roomId), eq(roomBan.userId, userId)))
        .limit(1);
      if (ban) {
        drain(data.file);
        return reply.status(403).send({ error: "forbidden" });
      }

      const commentField = fields.comment?.value;
      let comment: string | null = null;
      if (typeof commentField === "string" && commentField.length > 0) {
        if (commentField.length > COMMENT_MAX) {
          drain(data.file);
          return reply.status(400).send({ error: "comment_too_long" });
        }
        comment = commentField.normalize("NFC");
      }

      // R4 — `originalName` is preserved verbatim modulo NFC normalisation
      // (same pipeline as message body per REQ-031). Path-unsafe characters
      // are NOT stripped from this column; sanitisation lives in the
      // storagePath derivation instead (R10).
      const originalName = (data.filename ?? "").normalize("NFC");
      const mimeType = data.mimetype || "application/octet-stream";

      // REQ-075 defense-in-depth MIME allowlist. Rejection is decided BEFORE
      // we spool any bytes: the multipart part headers (including mimetype)
      // arrive with `request.file()`, so the file stream has not yet been
      // consumed. Draining keeps the client connection tidy.
      if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        drain(data.file);
        request.log.info(
          { mimeType, policy: "attachment-allowlist" },
          "attachment mime rejected",
        );
        return reply
          .status(415)
          .send({ error: "attachment_mime_unsupported" });
      }

      const attachmentId = randomUUID();
      const { relativePath, absolutePath } = buildStoragePath(
        attachmentId,
        originalName,
      );

      try {
        await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
      } catch (err) {
        drain(data.file);
        request.log.error({ err, absolutePath }, "attachment mkdir failed");
        return reply.status(500).send({ error: "storage_unavailable" });
      }

      // P0 — DoS-amplifier fix: track bytesWritten while the stream is still
      // flowing. When the declared mimetype is `image/*` we abort at
      // IMAGE_CAP_BYTES + 1; for anything else we abort at FILE_CAP_BYTES + 1
      // (the outer @fastify/multipart `fileSize: 20 MB` limit still marks
      // `.truncated` as a belt-and-suspenders defense — see R7 below). The
      // abort is `file.destroy(err)` with a sentinel code; the pipeline
      // rejection below decodes the sentinel into the right 413.
      let bytesWritten = 0;
      const isImage = mimeType.startsWith("image/");
      const perStreamCap = isImage ? IMAGE_CAP_BYTES : FILE_CAP_BYTES;
      let abortCode: typeof ERR_IMAGE_CAP | typeof ERR_FILE_CAP | null = null;
      data.file.on("data", (chunk: Buffer) => {
        bytesWritten += chunk.length;
        if (abortCode === null && bytesWritten > perStreamCap) {
          abortCode = isImage ? ERR_IMAGE_CAP : ERR_FILE_CAP;
          // Stops further `data` events and rejects the pipeline.
          data.file.destroy(new Error(abortCode));
        }
      });

      try {
        await pipeline(data.file, fs.createWriteStream(absolutePath));
      } catch (err) {
        await fs.promises.unlink(absolutePath).catch(() => {});
        if (abortCode === ERR_IMAGE_CAP) {
          return reply.status(413).send({ error: "image_too_large" });
        }
        if (abortCode === ERR_FILE_CAP) {
          return reply.status(413).send({ error: "file_too_large" });
        }
        request.log.error({ err, absolutePath }, "attachment write failed");
        return reply.status(500).send({ error: "storage_unavailable" });
      }

      // R7 — multipart's fileSize cap marks the stream truncated if the byte
      // limit was hit. We unlink the partial file and surface 413; the row
      // is never inserted. Still covered here as belt-and-suspenders — the
      // early-abort above should already have tripped in practice.
      if (data.file.truncated) {
        await fs.promises.unlink(absolutePath).catch(() => {});
        return reply.status(413).send({ error: "file_too_large" });
      }

      try {
        await db.insert(attachment).values({
          id: attachmentId,
          messageId: null,
          roomId,
          uploaderId: userId,
          originalName,
          storagePath: relativePath,
          mimeType,
          sizeBytes: bytesWritten,
          comment,
        });
      } catch (err) {
        await fs.promises.unlink(absolutePath).catch(() => {});
        request.log.error({ err }, "attachment row insert failed");
        return reply.status(500).send({ error: "storage_unavailable" });
      }

      // REQ-E-UPLOAD-RESP — echo persisted `comment` (post-NFC, or null for
      // the empty-string case) so the client reflects exactly what was stored.
      return reply.status(201).send({ attachmentId, comment });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/:id",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const headers = toFetchHeaders(request);
      const session = await auth.api.getSession({ headers });
      if (!session) {
        return reply.status(401).send({ error: "unauthorized" });
      }
      const userId = session.user.id;

      // REQ-E-REVOKE-GATE — gate is `room_member ∧ ¬room_ban`, evaluated on
      // every request (no signed URLs, no cached grants). The ban LEFT JOIN
      // is what makes the check robust to future states where a member row
      // somehow coexists with a ban (e.g., admin re-add without clearing the
      // ban). Wave-1 moderation deletes the member row on kick, but the gate
      // doesn't rely on that ordering.
      const [row] = await db
        .select({
          id: attachment.id,
          roomId: attachment.roomId,
          originalName: attachment.originalName,
          storagePath: attachment.storagePath,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          memberId: roomMember.id,
          banId: roomBan.id,
        })
        .from(attachment)
        .leftJoin(
          roomMember,
          and(
            eq(roomMember.roomId, attachment.roomId),
            eq(roomMember.userId, userId),
          ),
        )
        .leftJoin(
          roomBan,
          and(
            eq(roomBan.roomId, attachment.roomId),
            eq(roomBan.userId, userId),
          ),
        )
        .where(eq(attachment.id, request.params.id))
        .limit(1);
      // Probe-oracle suppression: collapse "row missing" and "gate failed"
      // into the same 403. Brief §2.6.4 calls this defense-in-depth — a
       // caller without a valid membership cannot tell apart "wrong id" from
      // "right id, no access," so attachment-id existence isn't a leak vector
      // even if UUIDv4 entropy were ever weakened.
      if (!row || !row.memberId || row.banId) {
        return reply.status(403).send({ error: "forbidden" });
      }

      const onDisk = resolveStorageAbsolute(row.storagePath);
      if (!fs.existsSync(onDisk)) {
        request.log.error({ onDisk, id: row.id }, "attachment file missing");
        return reply.status(500).send({ error: "storage_gone" });
      }

      // R11 — RFC 5987 Content-Disposition. `filename*=UTF-8''<pct-encoded>`
      // survives unicode filenames (REQ-078 + R4). Always `attachment` so the
      // browser never auto-executes scripts; inline preview is S3-owned.
      const encoded = encodeRFC5987(row.originalName);
      reply.header("content-type", row.mimeType);
      reply.header("content-length", row.sizeBytes);
      reply.header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encoded}`,
      );

      return reply.send(fs.createReadStream(onDisk));
    },
  );
}

// RFC 5987 §3.2.1 — percent-encode every byte that is not an attr-char
// (ALPHA / DIGIT / "!" / "#" / "$" / "&" / "+" / "-" / "." / "^" / "_" / "`" /
// "|" / "~"). encodeURIComponent covers most of this but leaves !*'() alone,
// so we escape those afterwards.
function encodeRFC5987(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
