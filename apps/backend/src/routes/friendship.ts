// S2 friendship routes — REQ-050..060 + REQ-073/074.
// Binding spec: docs/specs/s2-friendship.md. See §5 for the REST surface.
//
// Auth pattern mirrors routes/sessions.ts — better-auth session lookup via the
// toFetchHeaders adapter. No room membership involved; friendship is a
// cross-room relationship, so the helper is local and does not reuse
// requireRoomMember.
//
// Handlers land one-per-commit via TDD. This scaffold wires routing + auth so
// R19 (every endpoint returns 401 without a session) is satisfied out of the
// gate; bodies default to 501 until each R-task's test-first cycle fills them.

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import { randomUUID } from "node:crypto";
import { z, type ZodType } from "zod";
import { and, eq, gt } from "drizzle-orm";
import { sendFriendRequestSchema, type SendFriendRequestInput } from "@ai-herders/shared/dto";
import { friendRequest, friendship, user, userBlock } from "@ai-herders/shared/schema";

import { auth } from "../auth";
import { db } from "../db";
import { toFetchHeaders } from "../lib/fetch-headers";
import { checkFriendRequestRateLimit } from "../lib/friend-rate-limit";

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

// REQ-051 target resolution. Accepts either `toUsername` or `toUserId`;
// returns `null` if the named user does not exist. The DTO union guarantees
// exactly one of the two keys is present post-parse.
async function resolveTargetUserId(
  body: SendFriendRequestInput,
): Promise<string | null> {
  if ("toUserId" in body) {
    const [row] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, body.toUserId))
      .limit(1);
    return row?.id ?? null;
  }
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.username, body.toUsername))
    .limit(1);
  return row?.id ?? null;
}

export interface FriendshipAuthContext {
  userId: string;
  username: string;
}

export async function requireFriendshipAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FriendshipAuthContext | null> {
  const headers = toFetchHeaders(request);
  const me = await auth.api.getSession({ headers });
  if (!me) {
    reply.status(401).send({ error: "unauthorized" });
    return null;
  }
  // better-auth additionalField; same cast as message-auth.ts — auth.ts
  // registers username as required on user.additionalFields.
  const username = (me.user as { username?: string }).username ?? "";
  return { userId: me.user.id, username };
}

function notImplemented(reply: FastifyReply) {
  return reply.status(501).send({ error: "not_implemented" });
}

const directionQuerySchema = z.object({
  direction: z.enum(["incoming", "outgoing"]),
});

export async function friendshipRoutes(app: FastifyInstance): Promise<void> {
  // R1 / REQ-050 — GET /api/v1/friends
  app.get("/friends", async (request, reply) => {
    const ctx = await requireFriendshipAuth(request, reply);
    if (!ctx) return;

    // Friendship rows normalize userAId < userBId; the caller can be on either
    // side. Two branches (caller=A joins B; caller=B joins A) unioned in JS so
    // each column-pair gets an indexed lookup path.
    const asA = await db
      .select({
        friendId: friendship.userBId,
        friendedAt: friendship.createdAt,
        username: user.username,
        name: user.name,
      })
      .from(friendship)
      .innerJoin(user, eq(user.id, friendship.userBId))
      .where(eq(friendship.userAId, ctx.userId));

    const asB = await db
      .select({
        friendId: friendship.userAId,
        friendedAt: friendship.createdAt,
        username: user.username,
        name: user.name,
      })
      .from(friendship)
      .innerJoin(user, eq(user.id, friendship.userAId))
      .where(eq(friendship.userBId, ctx.userId));

    const friends = [...asA, ...asB]
      .map((r) => ({
        userId: r.friendId,
        username: r.username,
        name: r.name,
        friendedAt: r.friendedAt.toISOString(),
      }))
      .sort((x, y) => (x.friendedAt > y.friendedAt ? -1 : x.friendedAt < y.friendedAt ? 1 : 0));

    return reply.status(200).send({ friends });
  });

  // R2/R4/R5/R6 / REQ-051..055 — POST /api/v1/friends/requests
  app.post(
    "/friends/requests",
    { preHandler: zodBodyGuard(sendFriendRequestSchema) },
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      // R5 / REQ-054 — rate-limit check runs BEFORE target resolution so
      // a caller can't enumerate usernames nor burn the bucket on a
      // blocked target for free (§5 ordering step 3).
      const rl = await checkFriendRequestRateLimit(ctx.userId);
      if (!rl.allowed) {
        return reply
          .status(429)
          .send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      }

      const body = request.body as SendFriendRequestInput;
      const targetId = await resolveTargetUserId(body);
      if (!targetId) {
        return reply.status(404).send({ error: "user_not_found" });
      }
      if (targetId === ctx.userId) {
        return reply.status(400).send({ error: "self_request" });
      }

      // R4 / REQ-053 — sentinel success: if the target has blocked the
      // caller, return the same 201 shape as the real-insert path without
      // persisting a row. The fabricated UUID is opaque to the caller; no
      // consumer reads it back from the DB.
      const [blockRow] = await db
        .select({ id: userBlock.id })
        .from(userBlock)
        .where(and(eq(userBlock.byId, targetId), eq(userBlock.targetId, ctx.userId)))
        .limit(1);
      if (blockRow) {
        return reply.status(201).send({ id: randomUUID(), status: "pending" });
      }

      // R6 / REQ-055 — duplicate semantics on unique (fromId, toId).
      // pending  → UPDATE message + createdAt, return 200 same id
      // accepted → 409 already_friends
      // rejected → 409 request_declined (Q5a: decline is terminal)
      const messageText = body.message ?? null;
      const [existing] = await db
        .select({
          id: friendRequest.id,
          status: friendRequest.status,
        })
        .from(friendRequest)
        .where(
          and(
            eq(friendRequest.fromId, ctx.userId),
            eq(friendRequest.toId, targetId),
          ),
        )
        .limit(1);

      if (existing) {
        if (existing.status === "accepted") {
          return reply.status(409).send({ error: "already_friends" });
        }
        if (existing.status === "rejected") {
          return reply.status(409).send({ error: "request_declined" });
        }
        await db
          .update(friendRequest)
          .set({ message: messageText, createdAt: new Date() })
          .where(eq(friendRequest.id, existing.id));
        return reply.status(200).send({ id: existing.id, status: "pending" });
      }

      const id = randomUUID();
      await db.insert(friendRequest).values({
        id,
        fromId: ctx.userId,
        toId: targetId,
        message: messageText,
      });
      return reply.status(201).send({ id, status: "pending" });
    },
  );

  // R14/R15/R7 — GET /api/v1/friends/requests?direction=
  app.get<{ Querystring: { direction?: string } }>(
    "/friends/requests",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const parsed = directionQuerySchema.safeParse(request.query);
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

      // R7 — 30-day read-side TTL. Rows older than 30d are hidden even
      // though status='pending' (nightly hard-sweep is S3 / REQ-163).
      const ttlCutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000);
      const isIncoming = parsed.data.direction === "incoming";
      const selfColumn = isIncoming ? friendRequest.toId : friendRequest.fromId;
      const otherColumn = isIncoming ? friendRequest.fromId : friendRequest.toId;

      const rows = await db
        .select({
          id: friendRequest.id,
          message: friendRequest.message,
          createdAt: friendRequest.createdAt,
          otherUserId: otherColumn,
          otherUsername: user.username,
          otherName: user.name,
        })
        .from(friendRequest)
        .innerJoin(user, eq(user.id, otherColumn))
        .where(
          and(
            eq(selfColumn, ctx.userId),
            eq(friendRequest.status, "pending"),
            gt(friendRequest.createdAt, ttlCutoff),
          ),
        )
        .orderBy(friendRequest.createdAt);

      const requests = rows
        .map((r) => {
          const counterparty = {
            userId: r.otherUserId,
            username: r.otherUsername,
            name: r.otherName,
          };
          return {
            id: r.id,
            message: r.message,
            createdAt: r.createdAt.toISOString(),
            ...(isIncoming ? { from: counterparty } : { to: counterparty }),
          };
        })
        // Newest first. Drizzle's orderBy can't take desc on an aliased
        // column from a union; sort in JS after map.
        .sort((a, b) =>
          a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0,
        );

      return reply.status(200).send({ requests });
    },
  );

  // R8 / REQ-057 accept — caller must be toId. Pending→accepted flips status,
  // stamps respondedAt, and inserts a normalized friendship row. Accepted and
  // rejected are terminal (accepted=409 already_friends; rejected=409
  // request_declined per Q5a). Missing rows and rows targeted at someone else
  // both return 404 — we don't distinguish to avoid leaking existence.
  app.post<{ Params: { id: string } }>(
    "/friends/requests/:id/accept",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const [row] = await db
        .select({
          id: friendRequest.id,
          fromId: friendRequest.fromId,
          toId: friendRequest.toId,
          status: friendRequest.status,
        })
        .from(friendRequest)
        .where(eq(friendRequest.id, request.params.id))
        .limit(1);

      if (!row || row.toId !== ctx.userId) {
        return reply.status(404).send({ error: "not_found" });
      }
      if (row.status === "accepted") {
        return reply.status(409).send({ error: "already_friends" });
      }
      if (row.status === "rejected") {
        return reply.status(409).send({ error: "request_declined" });
      }

      // Normalize pair: userAId < userBId (spec §5 convention; migration 0003
      // enforces with CHECK constraint, so bad sort here would blow up the txn).
      const [userAId, userBId] =
        row.fromId < row.toId ? [row.fromId, row.toId] : [row.toId, row.fromId];
      const friendshipId = randomUUID();
      const acceptedAt = new Date();

      await db.transaction(async (tx) => {
        await tx
          .update(friendRequest)
          .set({ status: "accepted", respondedAt: acceptedAt })
          .where(eq(friendRequest.id, row.id));
        await tx.insert(friendship).values({
          id: friendshipId,
          userAId,
          userBId,
        });
      });

      // R11 / REQ-058 — at-most-once best-effort notification to the
      // requester's per-user room. No watermark, no replay on reconnect;
      // ADR-0003's ordering contract is scoped to room messages. Emit AFTER
      // the txn commits so a failed insert can't leak a phantom event.
      request.server.io
        .to(`user:${row.fromId}`)
        .emit("friend.request.accepted", {
          type: "friend.request.accepted",
          requestId: row.id,
          friendId: ctx.userId,
          friendUsername: ctx.username,
          acceptedAt: acceptedAt.toISOString(),
        });

      return reply.status(200).send({ status: "accepted", friendshipId });
    },
  );

  // R9 / REQ-057 decline — caller must be toId. Silent per REQ-058.
  // Terminal states: accepted → 409 already_friends (decline can't reverse
  // acceptance); rejected → 200 idempotent (calling decline on an already-
  // rejected row is a no-op with the same response shape).
  app.post<{ Params: { id: string } }>(
    "/friends/requests/:id/decline",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const [row] = await db
        .select({
          id: friendRequest.id,
          toId: friendRequest.toId,
          status: friendRequest.status,
        })
        .from(friendRequest)
        .where(eq(friendRequest.id, request.params.id))
        .limit(1);

      if (!row || row.toId !== ctx.userId) {
        return reply.status(404).send({ error: "not_found" });
      }
      if (row.status === "accepted") {
        return reply.status(409).send({ error: "already_friends" });
      }
      if (row.status === "rejected") {
        return reply.status(200).send({ status: "rejected" });
      }

      await db
        .update(friendRequest)
        .set({ status: "rejected", respondedAt: new Date() })
        .where(eq(friendRequest.id, row.id));

      return reply.status(200).send({ status: "rejected" });
    },
  );

  // R10 / REQ-057 block from request
  app.post<{ Params: { id: string } }>(
    "/friends/requests/:id/block",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;
      return notImplemented(reply);
    },
  );

  // R12 / REQ-059 — DELETE /api/v1/friends/:userId
  app.delete<{ Params: { userId: string } }>(
    "/friends/:userId",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;
      return notImplemented(reply);
    },
  );

  // R16 / REQ-073 — POST /api/v1/users/:id/block
  app.post<{ Params: { id: string } }>(
    "/users/:id/block",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;
      return notImplemented(reply);
    },
  );

  // R18 / REQ-074 — DELETE /api/v1/users/:id/ban
  app.delete<{ Params: { id: string } }>(
    "/users/:id/ban",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;
      return notImplemented(reply);
    },
  );
}
