// REQ-029 POST /api/v1/rooms/:id/messages — send a message.
// REQ-035 GET  /api/v1/rooms/:id/messages — history + gap-fill (task 6).
//
// Auth + membership via requireRoomMember (R14). Body is zod-parsed, then
// NFC-normalized + control-char-stripped (REQ-031), then passed through the
// atomic seq allocator (REQ-030/032/037). The returned row is serialized to
// the MessagePayload wire shape (bigint→string, Date→ISO).
//
// Socket.IO broadcast (REQ-034) is wired in task 7 — this file will reach the
// io instance through request.server.io once the fastify decorator is in place
// (see spec §5 "io plumbing"). Broadcast is intentionally absent for now.

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { historyQuerySchema, sendMessageSchema } from "@ai-herders/shared/dto";
import {
  attachment,
  message,
  messageSeq,
  room,
  type Message,
} from "@ai-herders/shared/schema";
import type {
  AttachmentPayload,
  HistorySliceResponse,
  MessageNewEvent,
  MessagePayload,
} from "@ai-herders/shared/protocol";

import { db } from "../db";
import { isDmFrozen } from "../lib/dm-freeze";
import { requireRoomMember } from "../lib/message-auth";
import { normalizeBody } from "../lib/message-text";
import { recordMessageSent } from "../lib/metrics";
import {
  allocateAndInsertMessage,
  AttachmentLinkError,
} from "../lib/seq-allocator";

function zodBodyGuard<T>(schema: ZodType<T>): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = schema.safeParse(request.body);
    if (result.success) {
      request.body = result.data;
      return;
    }
    reply.status(400).send({
      error: "validation",
      issues: result.error.issues.map((i) => ({
        path: i.path,
        message: i.message,
        code: i.code,
      })),
    });
  };
}

export function toMessagePayload(row: Message): MessagePayload {
  return {
    id: row.id,
    roomId: row.roomId,
    authorId: row.authorId,
    authorUsername: row.authorUsername,
    authorName: row.authorName,
    body: row.body,
    seq: row.seq.toString(),
    replyToId: row.replyToId ?? null,
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// R17 — AttachmentPayload for wire broadcast. `downloadUrl` is relative so
// the web client prefixes with NEXT_PUBLIC_BACKEND_URL (see protocol.ts).
// Order is ASC on attachment.id to match the upload order (uuids are random,
// so order-by-id is effectively arbitrary but stable — same for the
// message.new broadcast and the history slice).
async function loadAttachmentPayloads(
  messageId: string,
): Promise<AttachmentPayload[]> {
  const rows = await db
    .select({
      id: attachment.id,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      comment: attachment.comment,
    })
    .from(attachment)
    .where(eq(attachment.messageId, messageId));
  return rows.map((row) => ({
    id: row.id,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    comment: row.comment,
    downloadUrl: `/api/v1/attachments/${row.id}`,
  }));
}

async function loadAttachmentPayloadsForMessages(
  messageIds: string[],
): Promise<Map<string, AttachmentPayload[]>> {
  const out = new Map<string, AttachmentPayload[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select({
      id: attachment.id,
      messageId: attachment.messageId,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      comment: attachment.comment,
    })
    .from(attachment)
    .where(inArray(attachment.messageId, messageIds));
  for (const row of rows) {
    if (!row.messageId) continue;
    const list = out.get(row.messageId) ?? [];
    list.push({
      id: row.id,
      originalName: row.originalName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      comment: row.comment,
      downloadUrl: `/api/v1/attachments/${row.id}`,
    });
    out.set(row.messageId, list);
  }
  return out;
}

type SendBody = {
  body: string;
  replyToId?: string;
  attachmentIds?: string[];
  clientMessageId?: string;
};

export async function messagesRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: SendBody }>(
    "/:id/messages",
    { preHandler: zodBodyGuard(sendMessageSchema) },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: SendBody }>,
      reply: FastifyReply,
    ) => {
      const roomId = request.params.id;
      const ctx = await requireRoomMember(request, reply, roomId);
      if (!ctx) return;

      // R5 (REQ-066) — freeze check on DM rooms only. Group rooms skip.
      // The predicate reads friendship + user_block at read time; no
      // stored frozen_at (ADR-0007). 409 returns BEFORE seq allocation
      // so no side effects leak on a frozen send.
      const [roomRow] = await db
        .select({ kind: room.kind })
        .from(room)
        .where(eq(room.id, roomId))
        .limit(1);
      if (roomRow?.kind === "dm") {
        const freeze = await isDmFrozen({ roomId, callerId: ctx.userId });
        if (freeze.frozen) {
          return reply.status(409).send({
            error: "dialog_frozen",
            reason: freeze.reason,
          });
        }
      }

      const normalized = normalizeBody(request.body.body);
      if (normalized.length === 0) {
        // Post-normalization the body could be entirely stripped (pure control
        // characters). We treat that as invalid input, the same way the zod
        // min(1) rejects an empty submission.
        return reply.status(400).send({
          error: "validation",
          issues: [
            {
              path: ["body"],
              message: "body reduces to empty after normalization",
              code: "custom",
            },
          ],
        });
      }

      const attachmentIds = request.body.attachmentIds ?? [];
      let inserted: Message;
      let roomHeadSeq: bigint;
      let deduped: boolean;
      try {
        const res = await allocateAndInsertMessage({
          messageId: randomUUID(),
          roomId,
          authorId: ctx.userId,
          authorUsername: ctx.username,
          authorName: ctx.name,
          body: normalized,
          replyToId: request.body.replyToId ?? null,
          clientMessageId: request.body.clientMessageId ?? null,
          attachmentIds,
        });
        inserted = res.message;
        roomHeadSeq = res.roomHeadSeq;
        deduped = res.deduped;
      } catch (err) {
        if (err instanceof AttachmentLinkError) {
          // R12 — tx rolled back, no seq consumed, no message row; attachment
          // rows retain messageId=NULL (orphan, S3 GC sweeps).
          return reply.status(400).send({ error: "attachment_invalid" });
        }
        throw err;
      }

      const payload = toMessagePayload(inserted);
      if (attachmentIds.length > 0 && !deduped) {
        payload.attachments = await loadAttachmentPayloads(inserted.id);
      }
      if (!deduped) {
        // REQ-158 admin metric: count fresh sends only. Dedup-on-retry must
        // not double-count — same rationale as the broadcast skip below.
        recordMessageSent();
        // REQ-034 watermark broadcast. For a fresh send, seq === roomHeadSeq.
        // On dedup we intentionally skip the emit — subscribers already saw
        // this message on its first commit.
        const evt: MessageNewEvent = {
          type: "message.new",
          roomId,
          seq: payload.seq,
          roomHeadSeq: roomHeadSeq.toString(),
          message: payload,
        };
        request.server.io.to(roomId).emit("message.new", evt);
      }

      return reply.status(201).send(payload);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/:id/messages",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const parsed = historyQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "validation",
          issues: parsed.error.issues.map((i) => ({
            path: i.path,
            message: i.message,
            code: i.code,
          })),
        });
      }

      const roomId = request.params.id;
      const ctx = await requireRoomMember(request, reply, roomId);
      if (!ctx) return;

      const [seqRow] = await db
        .select({ seq: messageSeq.seq })
        .from(messageSeq)
        .where(eq(messageSeq.roomId, roomId))
        .limit(1);
      const roomHeadSeq = seqRow?.seq ?? 0n;

      const limit = BigInt(parsed.data.limit);
      // Compute the [fromSeq, toSeq] window. If the caller passed an explicit
      // slice we honour it verbatim; otherwise we return the newest `limit`
      // messages ending at the current head.
      let fromSeq: bigint;
      let toSeq: bigint;
      if (parsed.data.fromSeq !== undefined && parsed.data.toSeq !== undefined) {
        fromSeq = parsed.data.fromSeq;
        toSeq = parsed.data.toSeq;
      } else if (parsed.data.fromSeq !== undefined) {
        fromSeq = parsed.data.fromSeq;
        toSeq = roomHeadSeq;
      } else if (parsed.data.toSeq !== undefined) {
        toSeq = parsed.data.toSeq;
        fromSeq = toSeq - limit + 1n;
        if (fromSeq < 1n) fromSeq = 1n;
      } else {
        toSeq = roomHeadSeq;
        if (roomHeadSeq === 0n) {
          fromSeq = 0n;
        } else {
          fromSeq = roomHeadSeq - limit + 1n;
          if (fromSeq < 1n) fromSeq = 1n;
        }
      }

      const rows =
        roomHeadSeq === 0n
          ? []
          : await db
              .select()
              .from(message)
              .where(
                and(
                  eq(message.roomId, roomId),
                  gte(message.seq, fromSeq),
                  lte(message.seq, toSeq),
                  isNull(message.deletedAt),
                ),
              )
              .orderBy(asc(message.seq))
              .limit(parsed.data.limit);

      const payloads = rows.map(toMessagePayload);
      if (payloads.length > 0) {
        const byMessageId = await loadAttachmentPayloadsForMessages(
          payloads.map((p) => p.id),
        );
        for (const p of payloads) {
          const atts = byMessageId.get(p.id);
          if (atts && atts.length > 0) p.attachments = atts;
        }
      }

      const response: HistorySliceResponse = {
        roomId,
        fromSeq: fromSeq.toString(),
        toSeq: toSeq.toString(),
        roomHeadSeq: roomHeadSeq.toString(),
        messages: payloads,
      };
      return reply.status(200).send(response);
    },
  );
}
