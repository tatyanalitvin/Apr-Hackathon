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
import { createClient, type RedisClientType } from "redis";
import {
  editMessageSchema,
  historyQuerySchema,
  sendMessageSchema,
} from "@ai-herders/shared/dto";
import {
  attachment,
  message,
  messageSeq,
  room,
  user,
  type Message,
} from "@ai-herders/shared/schema";
import type {
  AttachmentPayload,
  HistorySliceResponse,
  MessageDeletedEvent,
  MessageEditedEvent,
  MessageNewEvent,
  MessagePayload,
} from "@ai-herders/shared/protocol";

import { db } from "../db";
import { env } from "../env";
import { isDmFrozen } from "../lib/dm-freeze";
import { requireRoomMember } from "../lib/message-auth";
import { normalizeBody } from "../lib/message-text";
import { previewFromParent, type ParentRow } from "../lib/reply-preview";
import { recordMessageSent } from "../lib/metrics";
import {
  allocateAndInsertMessage,
  AttachmentLinkError,
} from "../lib/seq-allocator";
import { DELETED_USER_DISPLAY } from "../lib/users";

// REQ-110/112 — per-user rate limits for message edit + delete. Generous
// ceilings (brief §1b): editing a just-sent typo is normal, so 60/min on
// edit; delete is rarer so 30/min. Window is 60s — tight enough that a
// burst of UI-triggered retries can't starve a real user for long.
// Own Redis client mirrors the pattern from routes/rooms.ts so FLUSHDB in
// tests doesn't disturb unrelated buckets.
const MESSAGE_RATE_WINDOW_SECONDS = 60;
const MESSAGE_EDIT_LIMIT = 60;
const MESSAGE_DELETE_LIMIT = 30;
let messageRateClient: RedisClientType | undefined;

async function getMessageRateClient(): Promise<RedisClientType> {
  if (!messageRateClient) {
    const c: RedisClientType = createClient({ url: env.REDIS_URL });
    c.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[message-rate-limit] redis error:", err);
    });
    await c.connect();
    messageRateClient = c;
  }
  return messageRateClient;
}

async function checkMessageRateLimit(
  key: string,
  limit: number,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const c = await getMessageRateClient();
  const count = await c.incr(key);
  if (count === 1) {
    await c.expire(key, MESSAGE_RATE_WINDOW_SECONDS);
  }
  if (count <= limit) {
    return { allowed: true, retryAfterSec: 0 };
  }
  const ttl = await c.ttl(key);
  return {
    allowed: false,
    retryAfterSec: ttl > 0 ? ttl : MESSAGE_RATE_WINDOW_SECONDS,
  };
}

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

// REQ-018 — when the author's user row has `deletedAt != null` the
// serialization swaps the denormalised username/name for "[deleted user]".
// Callers that know the author is alive (send handler, live broadcasts) may
// omit the flag; history/DM-list paths JOIN user.deletedAt and pass it.
// REQ-110 (s2-replies R5) — optional `parent` arg hydrates the reply preview.
// `undefined` (caller doesn't hydrate) and `null` (caller knows there's none)
// both produce `replyTo: null`. The preview shape (truncation + ISO + deleted
// substitution) is delegated to `previewFromParent` — one helper, three
// callers: send handler (R5), history LEFT-JOIN (R6), DM listing (R8).
export function toMessagePayload(
  row: Message,
  authorDeleted = false,
  parent?: ParentRow | null,
): MessagePayload {
  const authorUsername = authorDeleted ? DELETED_USER_DISPLAY : row.authorUsername;
  const authorName = authorDeleted ? DELETED_USER_DISPLAY : row.authorName;
  return {
    id: row.id,
    roomId: row.roomId,
    authorId: row.authorId,
    authorUsername,
    authorName,
    body: row.body,
    seq: row.seq.toString(),
    replyToId: row.replyToId ?? null,
    replyTo: previewFromParent(parent),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
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

      // REQ-018 — after fetching messages, batch-lookup each distinct author
      // to learn their `user.deletedAt` state. The denormalised
      // authorUsername on `message` is a send-time snapshot (Slack/Discord
      // semantics) and does NOT track deletion; the lookup decides whether
      // the serializer swaps in "[deleted user]". A separate SELECT (vs a
      // JOIN in the main query) keeps the message path's plan stable and
      // doesn't risk changing row multiplicity.
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

      const deletedAuthorIds = new Set<string>();
      if (rows.length > 0) {
        const authorIds = [...new Set(rows.map((r) => r.authorId))];
        const authorRows = await db
          .select({ id: user.id, deletedAt: user.deletedAt })
          .from(user)
          .where(inArray(user.id, authorIds));
        for (const a of authorRows) {
          if (a.deletedAt !== null) deletedAuthorIds.add(a.id);
        }
      }

      const payloads = rows.map((r) =>
        toMessagePayload(r, deletedAuthorIds.has(r.authorId)),
      );
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

  // REQ-110/111/114 — PATCH /api/v1/rooms/:roomId/messages/:messageId
  //
  // Author-only edit. Updates `body` + stamps `editedAt`, leaves `seq`
  // untouched (watermark discipline, brief §6 non-neg #5). A
  // `message.edited` broadcast goes out on success so other subscribers of
  // the room reconcile the new text without an extra fetch. Deleted
  // messages reject with 410 — authors can't resurrect soft-deleted rows.
  //
  // Ordering mirrors the room-mgmt handlers: auth → room-member gate →
  // rate-limit → zod parse → resolve → authz → UPDATE → emit.
  app.patch<{
    Params: { id: string; messageId: string };
    Body: { body: string };
  }>(
    "/:id/messages/:messageId",
    async (request, reply) => {
      const roomId = request.params.id;
      const messageId = request.params.messageId;

      const ctx = await requireRoomMember(request, reply, roomId);
      if (!ctx) return;

      const rl = await checkMessageRateLimit(
        `rate:message-edit:${ctx.userId}`,
        MESSAGE_EDIT_LIMIT,
      );
      if (!rl.allowed) {
        return reply
          .status(429)
          .send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      }

      const parsed = editMessageSchema.safeParse(request.body);
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

      const normalized = normalizeBody(parsed.data.body);
      if (normalized.length === 0) {
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

      const [target] = await db
        .select()
        .from(message)
        .where(eq(message.id, messageId))
        .limit(1);
      // 404 for both "missing" and "in a different room" so edit cannot be
      // used as a cross-room id oracle (same rationale as sessions / room
      // auth gates).
      if (!target || target.roomId !== roomId) {
        return reply.status(404).send({ error: "message_not_found" });
      }
      // Author-only — brief §6 non-neg #3. Admin moderation is out of scope
      // (brief §2 — s3-hardening territory).
      if (target.authorId !== ctx.userId) {
        return reply.status(403).send({ error: "not_message_author" });
      }
      if (target.deletedAt !== null) {
        // 410 Gone — row exists but has been soft-deleted. Brief §1b:
        // "can't edit a deleted message". Prefer 410 over 404 so the client
        // knows the id was valid and can fetch history to render the
        // tombstone state.
        return reply.status(410).send({ error: "message_deleted" });
      }

      const editedAt = new Date();
      const [updated] = await db
        .update(message)
        .set({ body: normalized, editedAt })
        .where(eq(message.id, messageId))
        .returning();
      if (!updated) {
        throw new Error(`PATCH message returned no row (id=${messageId})`);
      }

      const payload = toMessagePayload(updated);
      const atts = await loadAttachmentPayloads(messageId);
      if (atts.length > 0) payload.attachments = atts;

      // roomHeadSeq for the edited event — the broadcast doesn't change the
      // head (edits don't advance seq), so read the current value from the
      // allocator table. Stays consistent with the ADR-0003 watermark shape.
      const [seqRow] = await db
        .select({ seq: messageSeq.seq })
        .from(messageSeq)
        .where(eq(messageSeq.roomId, roomId))
        .limit(1);
      const roomHeadSeq = seqRow?.seq ?? updated.seq;

      const evt: MessageEditedEvent = {
        type: "message.edited",
        roomId,
        seq: updated.seq.toString(),
        roomHeadSeq: roomHeadSeq.toString(),
        messageId,
        body: normalized,
        editedAt: editedAt.toISOString(),
      };
      request.server.io.to(roomId).emit("message.edited", evt);

      return reply.status(200).send(payload);
    },
  );

  // REQ-112/113/114 — DELETE /api/v1/rooms/:roomId/messages/:messageId
  //
  // Author-only soft-delete. Clears body, sets deletedAt, cascades to
  // attachment rows (brief §1b: "delete attachment rows (if any)"). Seq
  // stays put so roomHeadSeq/unread counters don't jitter. Re-delete is
  // idempotent: 204 without a re-broadcast, deletedAt unchanged.
  app.delete<{ Params: { id: string; messageId: string } }>(
    "/:id/messages/:messageId",
    async (request, reply) => {
      const roomId = request.params.id;
      const messageId = request.params.messageId;

      const ctx = await requireRoomMember(request, reply, roomId);
      if (!ctx) return;

      const rl = await checkMessageRateLimit(
        `rate:message-delete:${ctx.userId}`,
        MESSAGE_DELETE_LIMIT,
      );
      if (!rl.allowed) {
        return reply
          .status(429)
          .send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      }

      const [target] = await db
        .select()
        .from(message)
        .where(eq(message.id, messageId))
        .limit(1);
      if (!target || target.roomId !== roomId) {
        return reply.status(404).send({ error: "message_not_found" });
      }
      if (target.authorId !== ctx.userId) {
        return reply.status(403).send({ error: "not_message_author" });
      }
      // Idempotent re-delete — no-op 204. Don't re-broadcast; subscribers
      // already saw the first `message.deleted` fanout.
      if (target.deletedAt !== null) {
        return reply.status(204).send();
      }

      const deletedAt = new Date();
      await db.transaction(async (tx) => {
        // Hard-delete the attachment rows. Brief §1b:
        // "attachments are per-message and no other row references them".
        // The message row itself is retained for seq continuity.
        await tx.delete(attachment).where(eq(attachment.messageId, messageId));
        await tx
          .update(message)
          .set({ body: "", deletedAt })
          .where(eq(message.id, messageId));
      });

      const [seqRow] = await db
        .select({ seq: messageSeq.seq })
        .from(messageSeq)
        .where(eq(messageSeq.roomId, roomId))
        .limit(1);
      const roomHeadSeq = seqRow?.seq ?? target.seq;

      const evt: MessageDeletedEvent = {
        type: "message.deleted",
        roomId,
        seq: target.seq.toString(),
        roomHeadSeq: roomHeadSeq.toString(),
        messageId,
        deletedAt: deletedAt.toISOString(),
      };
      request.server.io.to(roomId).emit("message.deleted", evt);

      return reply.status(204).send();
    },
  );
}
