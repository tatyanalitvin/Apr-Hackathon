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
import type { ZodType } from "zod";
import { eq } from "drizzle-orm";
import { sendFriendRequestSchema, type SendFriendRequestInput } from "@ai-herders/shared/dto";
import { friendRequest, friendship, user, userBlock } from "@ai-herders/shared/schema";
import { and } from "drizzle-orm";

import { auth } from "../auth";
import { db } from "../db";
import { toFetchHeaders } from "../lib/fetch-headers";

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
  app.get("/friends/requests", async (request, reply) => {
    const ctx = await requireFriendshipAuth(request, reply);
    if (!ctx) return;
    return notImplemented(reply);
  });

  // R8 / REQ-057 accept
  app.post<{ Params: { id: string } }>(
    "/friends/requests/:id/accept",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;
      return notImplemented(reply);
    },
  );

  // R9 / REQ-057 decline
  app.post<{ Params: { id: string } }>(
    "/friends/requests/:id/decline",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;
      return notImplemented(reply);
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
