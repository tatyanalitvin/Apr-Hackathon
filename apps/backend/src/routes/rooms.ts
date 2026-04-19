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
import {
  createRoomSchema,
  roomCreateResponseSchema,
  updateRoomSchema,
} from "@ai-herders/shared/dto";

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

// REQ-087 / REQ-089 — room-mgmt per-user rate limits. PATCH 10/hr, DELETE 5/hr.
// Modest ceilings (brief §3): rename + delete are owner-driven and shouldn't
// fire more than a handful of times per session. Own Redis client so FLUSHDB
// during tests doesn't disturb unrelated buckets. Both PATCH and DELETE share
// this client but use distinct key prefixes.
const ROOM_MGMT_WINDOW_SECONDS = 60 * 60;
const ROOM_PATCH_LIMIT = 10;
const ROOM_DELETE_LIMIT = 5;
let roomMgmtRateClient: RedisClientType | undefined;

async function getRoomMgmtRateClient(): Promise<RedisClientType> {
  if (!roomMgmtRateClient) {
    const c: RedisClientType = createClient({ url: env.REDIS_URL });
    c.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[room-mgmt-rate-limit] redis error:", err);
    });
    await c.connect();
    roomMgmtRateClient = c;
  }
  return roomMgmtRateClient;
}

async function checkRoomMgmtRateLimit(
  key: string,
  limit: number,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const c = await getRoomMgmtRateClient();
  const count = await c.incr(key);
  if (count === 1) {
    await c.expire(key, ROOM_MGMT_WINDOW_SECONDS);
  }
  if (count <= limit) {
    return { allowed: true, retryAfterSec: 0 };
  }
  const ttl = await c.ttl(key);
  return {
    allowed: false,
    retryAfterSec: ttl > 0 ? ttl : ROOM_MGMT_WINDOW_SECONDS,
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
        ownerId: room.ownerId,
        lastReadSeq: roomMember.lastReadSeq,
        mutedUntil: roomMember.mutedUntil,
        headSeq: messageSeq.seq,
        lastActivityAt: sql<Date | null>`MAX(${message.createdAt})`,
      })
      .from(roomMember)
      .innerJoin(room, eq(room.id, roomMember.roomId))
      .leftJoin(messageSeq, eq(messageSeq.roomId, roomMember.roomId))
      .leftJoin(message, eq(message.roomId, roomMember.roomId))
      .where(eq(roomMember.userId, ctx.userId))
      .groupBy(room.id, roomMember.lastReadSeq, roomMember.mutedUntil, messageSeq.seq)
      .orderBy(sql`MAX(${message.createdAt}) DESC NULLS LAST`, asc(room.name));

    // S2 room-mgmt — expose ownerId so the web can gate the Rename/Delete
    // settings controls on owner === session.user.id without a second round
    // trip. DM rows (ownerId may be non-null after recent DM seeding) still
    // reject modify via their dedicated 403 path; the UI hides settings on
    // kind === "dm" regardless.
    const payload = rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      visibility: r.visibility,
      ownerId: r.ownerId,
      lastReadSeq: r.lastReadSeq.toString(),
      roomHeadSeq: (r.headSeq ?? 0n).toString(),
      mutedUntil: r.mutedUntil ? r.mutedUntil.toISOString() : null,
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
    const { name, description, visibility } = parsed.data;
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
            visibility,
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
        visibility: created!.visibility,
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

  // REQ-087 — PATCH /api/v1/rooms/:id rename. Owner-only (room.ownerId ===
  // auth.user.id). DM rooms rejected (brief §3 pre-resolved — DMs mutate via
  // their own flow). Binding: .human/S2_ROOM_MGMT_UI_AGENT_BRIEF.md §1a.
  //
  // Ordering mirrors POST /rooms: auth → rate-limit → zod parse → resolve →
  // authz. Rate-limit runs before resolve so probing invalid ids still burns
  // the bucket (same rationale as the join handler above).
  app.patch<{ Params: { id: string } }>(
    "/rooms/:id",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const rl = await checkRoomMgmtRateLimit(
        `rate:room-patch:${ctx.userId}`,
        ROOM_PATCH_LIMIT,
      );
      if (!rl.allowed) {
        return reply
          .status(429)
          .send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      }

      const parsed = updateRoomSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "invalid_body", details: parsed.error.flatten() });
      }

      const roomId = request.params.id;
      const [target] = await db
        .select({
          id: room.id,
          name: room.name,
          description: room.description,
          kind: room.kind,
          ownerId: room.ownerId,
          createdAt: room.createdAt,
        })
        .from(room)
        .where(eq(room.id, roomId))
        .limit(1);
      if (!target) {
        return reply.status(404).send({ error: "room_not_found" });
      }
      if (target.kind === "dm") {
        return reply
          .status(403)
          .send({ error: "cannot_modify_dm_via_this_route" });
      }
      if (target.ownerId !== ctx.userId) {
        return reply.status(403).send({ error: "not_room_owner" });
      }

      // No-op when the body omits every mutable field. Still a 200 so the
      // client can treat PATCH as idempotent.
      const nextName = parsed.data.name ?? target.name;

      try {
        const [updated] = await db
          .update(room)
          .set({ name: nextName })
          .where(eq(room.id, roomId))
          .returning({
            id: room.id,
            name: room.name,
            description: room.description,
            ownerId: room.ownerId,
            createdAt: room.createdAt,
          });
        return reply.status(200).send({
          id: updated!.id,
          name: updated!.name,
          description: updated!.description,
          visibility: "public" as const,
          ownerId: updated!.ownerId!,
          createdAt: updated!.createdAt.toISOString(),
        });
      } catch (err) {
        if (isUniqueViolation(err, "room_name_ci_uq")) {
          return reply.status(409).send({ error: "name_taken" });
        }
        throw err;
      }
    },
  );

  // REQ-089 — DELETE /api/v1/rooms/:id. Owner-only cascade delete. Emits
  // `room.deleted` to room subscribers BEFORE the DB row disappears so
  // Socket.IO's per-room routing still sees the target.
  //
  // Cascade is automatic via FK ON DELETE CASCADE on:
  //   - room_member.room_id
  //   - message.room_id
  //   - message_seq.room_id
  //   - attachment.room_id
  //   - room_ban.room_id
  //   - room_invite.room_id
  //
  // Ordering mirrors PATCH: auth → rate-limit → resolve → DM guard → authz
  // → emit → DELETE. The emit-before-delete sequence mirrors Slack's
  // channel_deleted — clients need a signal to leave the room view before
  // subsequent history fetches start 404-ing.
  app.delete<{ Params: { id: string } }>(
    "/rooms/:id",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const rl = await checkRoomMgmtRateLimit(
        `rate:room-delete:${ctx.userId}`,
        ROOM_DELETE_LIMIT,
      );
      if (!rl.allowed) {
        return reply
          .status(429)
          .send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      }

      const roomId = request.params.id;
      const [target] = await db
        .select({
          id: room.id,
          kind: room.kind,
          ownerId: room.ownerId,
        })
        .from(room)
        .where(eq(room.id, roomId))
        .limit(1);
      if (!target) {
        return reply.status(404).send({ error: "room_not_found" });
      }
      if (target.kind === "dm") {
        return reply
          .status(403)
          .send({ error: "cannot_delete_dm_via_this_route" });
      }
      if (target.ownerId !== ctx.userId) {
        return reply.status(403).send({ error: "not_room_owner" });
      }

      const deletedAt = new Date();
      // Emit BEFORE the delete: room subscribers are still routed via the
      // live room_member rows at the moment of the emit. Delete first and
      // the fanout would miss everyone. At-most-once best-effort per
      // ADR-0003 — missed emits reconcile on the next /rooms/me fetch.
      request.server.io.to(roomId).emit("room.deleted", {
        type: "room.deleted",
        roomId,
        deletedAt: deletedAt.toISOString(),
        deletedBy: ctx.userId,
      });

      await db.delete(room).where(eq(room.id, roomId));

      return reply.status(204).send();
    },
  );
}
