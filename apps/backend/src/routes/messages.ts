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
import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { historyQuerySchema, sendMessageSchema } from "@ai-herders/shared/dto";
import { message, messageSeq, type Message } from "@ai-herders/shared/schema";
import type {
  HistorySliceResponse,
  MessageNewEvent,
  MessagePayload,
} from "@ai-herders/shared/protocol";

import { db } from "../db";
import { requireRoomMember } from "../lib/message-auth";
import { normalizeBody } from "../lib/message-text";
import { allocateAndInsertMessage } from "../lib/seq-allocator";

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
    body: row.body,
    seq: row.seq.toString(),
    replyToId: row.replyToId ?? null,
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

type SendBody = {
  body: string;
  replyToId?: string;
  attachmentIds?: string[];
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

      const { message: inserted, roomHeadSeq } = await allocateAndInsertMessage({
        messageId: randomUUID(),
        roomId,
        authorId: ctx.userId,
        body: normalized,
        replyToId: request.body.replyToId ?? null,
      });

      const payload = toMessagePayload(inserted);
      // REQ-034 watermark broadcast. For a fresh send, seq === roomHeadSeq
      // (the allocator advances the head by one and hands back both).
      const evt: MessageNewEvent = {
        type: "message.new",
        roomId,
        seq: payload.seq,
        roomHeadSeq: roomHeadSeq.toString(),
        message: payload,
      };
      request.server.io.to(roomId).emit("message.new", evt);

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

      const response: HistorySliceResponse = {
        roomId,
        fromSeq: fromSeq.toString(),
        toSeq: toSeq.toString(),
        roomHeadSeq: roomHeadSeq.toString(),
        messages: rows.map(toMessagePayload),
      };
      return reply.status(200).send(response);
    },
  );
}
