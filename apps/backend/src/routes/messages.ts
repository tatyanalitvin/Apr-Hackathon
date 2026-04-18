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
import { sendMessageSchema } from "@ai-herders/shared/dto";
import type { Message } from "@ai-herders/shared/schema";
import type { MessagePayload } from "@ai-herders/shared/protocol";

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

      const { message: inserted } = await allocateAndInsertMessage({
        messageId: randomUUID(),
        roomId,
        authorId: ctx.userId,
        body: normalized,
        replyToId: request.body.replyToId ?? null,
      });

      // TODO(task 7): emit message.new over Socket.IO to room `roomId` with
      // {seq, roomHeadSeq, message} per REQ-034. No-op until io is decorated
      // on the Fastify instance (see spec §5 "io plumbing").

      return reply.status(201).send(toMessagePayload(inserted));
    },
  );
}
