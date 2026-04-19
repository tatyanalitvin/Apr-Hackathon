// S2 rooms routes — REQ-025 (catalog), REQ-026 (self-join), plus non-v4
// /rooms/me caller-memberships endpoint.
// Binding spec: docs/specs/s2-rooms.md. See §4 R2/R3/R4 for the REST surface
// and §5 for rate-limit ordering.
//
// Auth pattern mirrors routes/friendship.ts — reuse requireFriendshipAuth
// (cross-feature; neither route family requires room membership). Each
// handler lands one-per-commit via TDD.

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { createClient, type RedisClientType } from "redis";
import { message, messageSeq, room, roomMember, user } from "@ai-herders/shared/schema";
import { createRoomSchema, roomCreateResponseSchema } from "@ai-herders/shared/dto";

import { db } from "../db";
import { env } from "../env";
import { isUniqueViolation } from "../lib/pg-error";
import { checkRoomCreateRateLimit } from "../lib/room-create-rate-limit";
import { requireFriendshipAuth } from "./friendship";

// Per-user 60/hour rate limit on POST /rooms/:id/join (spec §5).
// Separate Redis client from friend-rate-limit; both use their own
// namespaced keys ("rate:room-join:…" vs "rate:friend-req:…") so the
// buckets can't collide on FLUSHDB in tests. INCR + EXPIRE-on-first
// self-cleans; no external sweep needed.
const JOIN_RATE_WINDOW_SECONDS = 60 * 60;
const JOIN_RATE_LIMIT = 60;
let joinRateClient: RedisClientType | undefined;

async function getJoinRateClient(): Promise<RedisClientType> {
  if (!joinRateClient) {
    const c: RedisClientType = createClient({ url: env.REDIS_URL });
    c.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[room-join-rate-limit] redis error:", err);
    });
    await c.connect();
    joinRateClient = c;
  }
  return joinRateClient;
}

async function checkJoinRateLimit(
  userId: string,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const c = await getJoinRateClient();
  const key = `rate:room-join:${userId}`;
  const count = await c.incr(key);
  if (count === 1) {
    await c.expire(key, JOIN_RATE_WINDOW_SECONDS);
  }
  if (count <= JOIN_RATE_LIMIT) {
    return { allowed: true, retryAfterSec: 0 };
  }
  const ttl = await c.ttl(key);
  return {
    allowed: false,
    retryAfterSec: ttl > 0 ? ttl : JOIN_RATE_WINDOW_SECONDS,
  };
}

export async function roomsRoutes(app: FastifyInstance): Promise<void> {
  // R2 / REQ-026 — POST /api/v1/rooms/:id/join.
  // Idempotent via ON CONFLICT DO NOTHING on room_member (userId, roomId).
  // Repeat self-join returns 200 {joined:false} — never 409; join spam must
  // never fail loud (spec §8 non-neg #2).
  // 403 catches both private group rooms AND any kind='dm' room — DMs are
  // allocated by the DMs agent's flow, never self-joined (spec §8 non-neg #5).
  app.post<{ Params: { id: string } }>(
    "/rooms/:id/join",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      // §5 ordering: rate-limit runs BEFORE the resolve step so probing
      // invalid ids still burns the bucket (same rationale as friendship
      // REQ-054: bucketless lookups are free enumeration).
      const rl = await checkJoinRateLimit(ctx.userId);
      if (!rl.allowed) {
        return reply
          .status(429)
          .send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      }

      const [target] = await db
        .select({
          id: room.id,
          kind: room.kind,
          visibility: room.visibility,
        })
        .from(room)
        .where(eq(room.id, request.params.id))
        .limit(1);
      if (!target) {
        return reply.status(404).send({ error: "room_not_found" });
      }
      if (target.kind !== "group" || target.visibility !== "public") {
        return reply.status(403).send({ error: "room_not_joinable" });
      }

      // ON CONFLICT on the (user_id, room_id) unique index — insert is a
      // no-op when a membership already exists. rowCount distinguishes the
      // fresh-insert happy path from the idempotent-repeat no-op.
      const joinedAt = new Date();
      const insertResult = await db
        .insert(roomMember)
        .values({
          id: randomUUID(),
          userId: ctx.userId,
          roomId: target.id,
          joinedAt,
        })
        .onConflictDoNothing({
          target: [roomMember.userId, roomMember.roomId],
        });
      const joined = (insertResult.rowCount ?? 0) > 0;

      // Q1 — at-most-once socket fanout, fire only on new-membership
      // insert. Non-neg #3 (best-effort: no ack, no retry) and #4 (silent
      // on the idempotent-repeat path to avoid ghost-join toasts).
      if (joined) {
        request.server.io.to(target.id).emit("room.member.joined", {
          type: "room.member.joined",
          roomId: target.id,
          userId: ctx.userId,
          username: ctx.username,
          joinedAt: joinedAt.toISOString(),
        });
      }

      return reply.status(200).send({ joined });
    },
  );

  // R3 / REQ-025 — GET /api/v1/rooms — public-group catalog.
  // Q2 (pre-resolved): private rooms stay out of the catalog regardless of
  // caller membership; private rooms the caller belongs to surface via R4.
  // isMember uses COALESCE(BOOL_OR(...), false) because LEFT JOIN yields NULL
  // rows for rooms with zero members, and BOOL_OR over NULL is NULL.
  app.get("/rooms", async (request, reply) => {
    const ctx = await requireFriendshipAuth(request, reply);
    if (!ctx) return;

    const memberCountExpr = sql<number>`COUNT(${roomMember.userId})::int`;
    const rows = await db
      .select({
        id: room.id,
        name: room.name,
        kind: room.kind,
        visibility: room.visibility,
        memberCount: memberCountExpr,
        isMember: sql<boolean>`COALESCE(BOOL_OR(${roomMember.userId} = ${ctx.userId}), false)`,
      })
      .from(room)
      .leftJoin(roomMember, eq(roomMember.roomId, room.id))
      .where(and(eq(room.kind, "group"), eq(room.visibility, "public")))
      .groupBy(room.id)
      .orderBy(sql`${memberCountExpr} DESC`, asc(room.name));

    return reply.status(200).send({ rooms: rows });
  });

  // R4 (non-v4, see ADR-0006) — GET /api/v1/rooms/me.
  // One query: joins room + message_seq (for roomHeadSeq) + message (for
  // last-activity ordering), grouped by room. LEFT JOINs on both so fresh
  // rooms without messages or without a seq row still surface (NULLS LAST
  // keeps them at the tail). bigints serialize as strings on the wire —
  // ADR-0003 contract, same handling as message.seq.
  app.get("/rooms/me", async (request, reply) => {
    const ctx = await requireFriendshipAuth(request, reply);
    if (!ctx) return;

    const rows = await db
      .select({
        id: room.id,
        name: room.name,
        kind: room.kind,
        visibility: room.visibility,
        lastReadSeq: roomMember.lastReadSeq,
        headSeq: messageSeq.seq,
        lastActivityAt: sql<Date | null>`MAX(${message.createdAt})`,
      })
      .from(roomMember)
      .innerJoin(room, eq(room.id, roomMember.roomId))
      .leftJoin(messageSeq, eq(messageSeq.roomId, roomMember.roomId))
      .leftJoin(message, eq(message.roomId, roomMember.roomId))
      .where(eq(roomMember.userId, ctx.userId))
      .groupBy(room.id, roomMember.lastReadSeq, messageSeq.seq)
      .orderBy(sql`MAX(${message.createdAt}) DESC NULLS LAST`, asc(room.name));

    const payload = rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      visibility: r.visibility,
      lastReadSeq: r.lastReadSeq.toString(),
      roomHeadSeq: (r.headSeq ?? 0n).toString(),
    }));

    return reply.status(200).send({ rooms: payload });
  });

  // REQ-023 — POST /api/v1/rooms. Any authenticated user creates a public
  // group room. Enrolls the creator as role='owner' and seeds message_seq=0
  // in the same transaction. Binding spec: docs/specs/s1-rooms.md §4 R4/R5/R15.
  // Ordering (§5): auth → rate-limit → zod parse → transaction.
  app.post("/rooms", async (request, reply) => {
    const ctx = await requireFriendshipAuth(request, reply);
    if (!ctx) return;

    const rl = await checkRoomCreateRateLimit(ctx.userId);
    if (!rl.allowed) {
      return reply
        .status(429)
        .send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
    }

    const parsed = createRoomSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const { name, description } = parsed.data;
    const roomId = randomUUID();

    try {
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(room)
          .values({
            id: roomId,
            name,
            description: description ?? null,
            kind: "group",
            visibility: "public",
            ownerId: ctx.userId,
          })
          .returning();
        await tx.insert(roomMember).values({
          id: randomUUID(),
          userId: ctx.userId,
          roomId,
          role: "owner",
          joinedAt: new Date(),
        });
        await tx.insert(messageSeq).values({ roomId, seq: 0n });
        return row;
      });

      const body = roomCreateResponseSchema.parse({
        id: created!.id,
        name: created!.name,
        description: created!.description,
        visibility: "public" as const,
        ownerId: created!.ownerId!,
        createdAt: created!.createdAt.toISOString(),
      });
      return reply.status(201).send(body);
    } catch (err) {
      if (isUniqueViolation(err, "room_name_ci_uq")) {
        return reply.status(409).send({ error: "name_taken" });
      }
      throw err;
    }
  });

  // Gate-3 demo patch — GET /api/v1/rooms/:id/members.
  // Lets RoomClient key PresencePill on real user.id values instead of
  // seeded placeholders. Ordering: 404 unknown room → 403 non-member → 200
  // roster, same ordering discipline as DELETE /rooms/:id/members/me below.
  // Membership gate prevents DM roster enumeration (kind='dm' rooms).
  app.get<{ Params: { id: string } }>(
    "/rooms/:id/members",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const roomId = request.params.id;

      const [roomRow] = await db
        .select({ id: room.id })
        .from(room)
        .where(eq(room.id, roomId))
        .limit(1);
      if (!roomRow) {
        return reply.status(404).send({ error: "room_not_found" });
      }

      const [membership] = await db
        .select({ id: roomMember.id })
        .from(roomMember)
        .where(
          and(
            eq(roomMember.userId, ctx.userId),
            eq(roomMember.roomId, roomId),
          ),
        )
        .limit(1);
      if (!membership) {
        return reply.status(403).send({ error: "room_not_member" });
      }

      const members = await db
        .select({
          id: user.id,
          username: user.username,
          displayName: user.name,
        })
        .from(roomMember)
        .innerJoin(user, eq(user.id, roomMember.userId))
        .where(eq(roomMember.roomId, roomId))
        .orderBy(asc(user.username));

      return reply.status(200).send({ members });
    },
  );

  // REQ-027 — DELETE /api/v1/rooms/:id/members/me. Members leave freely;
  // owners cannot leave (they must delete the room — deferred to S2).
  // Binding spec: docs/specs/s1-rooms.md §4 R9/R10/R11/R12/R13.
  //
  // Order matters: check room existence FIRST (R12 404 is distinct from
  // the R10 idempotent non-member 204), THEN check role (R11 403 takes
  // precedence over R9/R10), THEN delete.
  app.delete<{ Params: { id: string } }>(
    "/rooms/:id/members/me",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const roomId = request.params.id;

      const [roomRow] = await db
        .select({ id: room.id })
        .from(room)
        .where(eq(room.id, roomId))
        .limit(1);
      if (!roomRow) {
        return reply.status(404).send({ error: "room_not_found" });
      }

      const [membership] = await db
        .select({ role: roomMember.role })
        .from(roomMember)
        .where(
          and(
            eq(roomMember.userId, ctx.userId),
            eq(roomMember.roomId, roomId),
          ),
        )
        .limit(1);
      if (membership?.role === "owner") {
        return reply.status(403).send({ error: "owner_cannot_leave" });
      }

      // Delete is idempotent by design: if no row exists the DELETE is a
      // no-op and we still return 204 (R10). No need to branch on row count.
      await db
        .delete(roomMember)
        .where(
          and(
            eq(roomMember.userId, ctx.userId),
            eq(roomMember.roomId, roomId),
          ),
        );

      return reply.status(204).send();
    },
  );
}
