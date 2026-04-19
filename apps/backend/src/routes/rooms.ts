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
import { aliasedTable, and, asc, desc, eq, sql } from "drizzle-orm";
import { createClient, type RedisClientType } from "redis";
import { message, messageSeq, room, roomBan, roomMember, user } from "@ai-herders/shared/schema";
import {
  createBanSchema,
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

      // REQ-203/204 — ban gate. Kick-as-ban and pre-emptive ban both land a
      // `room_ban` row; until an admin hits REQ-205 unban, the target's
      // rejoin attempt must fail. Checked after the rate-limit so a banned
      // user can't burn someone else's bucket, but before the insert so the
      // membership is never restored.
      const [banRow] = await db
        .select({ id: roomBan.id })
        .from(roomBan)
        .where(and(eq(roomBan.roomId, target.id), eq(roomBan.userId, ctx.userId)))
        .limit(1);
      if (banRow) {
        return reply.status(403).send({ error: "banned_from_room" });
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

  // REQ-201 — POST /api/v1/rooms/:id/admins/:userId. Owner-only promote
  // member→admin. Idempotent: already-admin returns {promoted:false} (silent);
  // owner target is 409 already_owner (v3.docx §2.4.7 "owner cannot lose
  // admin rights" — you can't re-promote an owner). Fanout on real promotions.
  //
  // Ordering (mirrors PATCH/DELETE above minus rate-limit — moderation RL is
  // punted to S3 per docs/FOLLOWUPS.md): auth → resolve room → authz
  // (owner?) → resolve target membership → state branch → UPDATE → emit.
  app.post<{ Params: { id: string; userId: string } }>(
    "/rooms/:id/admins/:userId",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const { id: roomId, userId: targetUserId } = request.params;

      const [target] = await db
        .select({ id: room.id, ownerId: room.ownerId })
        .from(room)
        .where(eq(room.id, roomId))
        .limit(1);
      if (!target) {
        return reply.status(404).send({ error: "room_not_found" });
      }
      if (target.ownerId !== ctx.userId) {
        return reply.status(403).send({ error: "not_owner" });
      }

      const [membership] = await db
        .select({ role: roomMember.role })
        .from(roomMember)
        .where(
          and(
            eq(roomMember.roomId, roomId),
            eq(roomMember.userId, targetUserId),
          ),
        )
        .limit(1);
      if (!membership) {
        return reply.status(404).send({ error: "user_not_member" });
      }
      if (membership.role === "owner") {
        return reply.status(409).send({ error: "already_owner" });
      }
      if (membership.role === "admin") {
        return reply.status(200).send({ promoted: false, role: "admin" });
      }

      await db
        .update(roomMember)
        .set({ role: "admin" })
        .where(
          and(
            eq(roomMember.roomId, roomId),
            eq(roomMember.userId, targetUserId),
          ),
        );

      const changedAt = new Date().toISOString();
      request.server.io.to(roomId).emit("room.role.changed", {
        type: "room.role.changed",
        roomId,
        userId: targetUserId,
        role: "admin",
        changedBy: ctx.userId,
        changedAt,
      });

      return reply.status(200).send({ promoted: true, role: "admin" });
    },
  );

  // REQ-202 — DELETE /api/v1/rooms/:id/admins/:userId. Owner-only demote
  // admin→member. Idempotent: already-member returns {demoted:false} (silent);
  // owner target is 409 cannot_demote_owner (v3.docx §2.4.7 — you can't demote
  // an owner). Fanout on real demotions.
  app.delete<{ Params: { id: string; userId: string } }>(
    "/rooms/:id/admins/:userId",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const { id: roomId, userId: targetUserId } = request.params;

      const [target] = await db
        .select({ id: room.id, ownerId: room.ownerId })
        .from(room)
        .where(eq(room.id, roomId))
        .limit(1);
      if (!target) {
        return reply.status(404).send({ error: "room_not_found" });
      }
      if (target.ownerId !== ctx.userId) {
        return reply.status(403).send({ error: "not_owner" });
      }

      const [membership] = await db
        .select({ role: roomMember.role })
        .from(roomMember)
        .where(
          and(
            eq(roomMember.roomId, roomId),
            eq(roomMember.userId, targetUserId),
          ),
        )
        .limit(1);
      if (!membership) {
        return reply.status(404).send({ error: "user_not_member" });
      }
      if (membership.role === "owner") {
        return reply.status(409).send({ error: "cannot_demote_owner" });
      }
      if (membership.role === "member") {
        return reply.status(200).send({ demoted: false, role: "member" });
      }

      await db
        .update(roomMember)
        .set({ role: "member" })
        .where(
          and(
            eq(roomMember.roomId, roomId),
            eq(roomMember.userId, targetUserId),
          ),
        );

      const changedAt = new Date().toISOString();
      request.server.io.to(roomId).emit("room.role.changed", {
        type: "room.role.changed",
        roomId,
        userId: targetUserId,
        role: "member",
        changedBy: ctx.userId,
        changedAt,
      });

      return reply.status(200).send({ demoted: true, role: "member" });
    },
  );

  // REQ-203 — DELETE /api/v1/rooms/:id/members/:userId. Kick-as-ban per
  // v3.docx §2.4.8 ("removal is treated as a ban"). Transaction: INSERT
  // room_ban (ON CONFLICT DO NOTHING) → DELETE room_member → emit
  // `room.member.kicked` → force every one of the target user's sockets out
  // of the room channel (REQ-208). `user:${userId}` is auto-joined in
  // socket-auth.ts:44. We use `.local.socketsLeave()`: the Redis adapter's
  // non-local path is fire-and-forget pub/sub (see redis-adapter delSockets
  // at index.js:599) so `await` doesn't actually wait; `.local` falls
  // through to the in-memory adapter's synchronous `socket.leave()` loop.
  // Correct for our single-backend deployment (and any sticky-session
  // cluster, since a user's sockets land on one server). Re-subscription by
  // those sockets is blocked by the membership gate at
  // socket-handlers.ts:101-110 (no room_member row → ack({ok:false})).
  app.delete<{ Params: { id: string; userId: string } }>(
    "/rooms/:id/members/:userId",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const { id: roomId, userId: targetUserId } = request.params;

      const [target] = await db
        .select({ id: room.id, ownerId: room.ownerId })
        .from(room)
        .where(eq(room.id, roomId))
        .limit(1);
      if (!target) {
        return reply.status(404).send({ error: "room_not_found" });
      }

      const [callerMembership] = await db
        .select({ role: roomMember.role })
        .from(roomMember)
        .where(
          and(eq(roomMember.roomId, roomId), eq(roomMember.userId, ctx.userId)),
        )
        .limit(1);
      if (
        !callerMembership ||
        (callerMembership.role !== "owner" && callerMembership.role !== "admin")
      ) {
        return reply.status(403).send({ error: "not_admin" });
      }

      const [targetMembership] = await db
        .select({ role: roomMember.role })
        .from(roomMember)
        .where(
          and(eq(roomMember.roomId, roomId), eq(roomMember.userId, targetUserId)),
        )
        .limit(1);
      if (!targetMembership) {
        return reply.status(404).send({ error: "user_not_member" });
      }
      if (targetMembership.role === "owner") {
        return reply.status(409).send({ error: "cannot_kick_owner" });
      }
      if (
        targetMembership.role === "admin" &&
        callerMembership.role !== "owner"
      ) {
        // Admins can't kick other admins — prevents admin-vs-admin wars.
        return reply.status(403).send({ error: "admin_cannot_kick_admin" });
      }

      await db.transaction(async (tx) => {
        await tx
          .insert(roomBan)
          .values({
            id: randomUUID(),
            roomId,
            userId: targetUserId,
            bannedById: ctx.userId,
            reason: null,
          })
          .onConflictDoNothing({
            target: [roomBan.roomId, roomBan.userId],
          });
        await tx
          .delete(roomMember)
          .where(
            and(
              eq(roomMember.roomId, roomId),
              eq(roomMember.userId, targetUserId),
            ),
          );
      });

      const kickedAt = new Date().toISOString();
      request.server.io.to(roomId).emit("room.member.kicked", {
        type: "room.member.kicked",
        roomId,
        userId: targetUserId,
        kickedBy: ctx.userId,
        kickedAt,
      });

      // REQ-208 — force every one of the target user's sockets to leave the
      // room channel. `.local` routes through the in-memory adapter, whose
      // `delSockets` is synchronous (calls `socket.leave(room)` in a loop)
      // — so after this line returns, no subsequent fanout to `roomId` can
      // reach the kicked user. Matters for the 500-ms dual-socket invariant.
      request.server.io.in(`user:${targetUserId}`).local.socketsLeave(roomId);

      return reply.status(200).send({ kicked: true, banned: true });
    },
  );

  // REQ-204 — POST /api/v1/rooms/:id/bans. Explicit pre-emptive ban (target
  // MAY not be a current member). If target IS a current member the handler
  // additionally deletes the membership row, emits `room.member.kicked`
  // (stronger signal — see protocol.ts note on `room.member.banned`), and
  // force-leaves the target's sockets (REQ-208). Response `{banned, kicked}`
  // where `kicked` = true iff a membership row was also removed.
  app.post<{ Params: { id: string } }>(
    "/rooms/:id/bans",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const parsed = createBanSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "invalid_body", details: parsed.error.flatten() });
      }
      const { userId: targetUserId, reason: reasonInput } = parsed.data;
      const reason = reasonInput ?? null;

      const { id: roomId } = request.params;

      const [target] = await db
        .select({ id: room.id })
        .from(room)
        .where(eq(room.id, roomId))
        .limit(1);
      if (!target) {
        return reply.status(404).send({ error: "room_not_found" });
      }

      const [callerMembership] = await db
        .select({ role: roomMember.role })
        .from(roomMember)
        .where(
          and(eq(roomMember.roomId, roomId), eq(roomMember.userId, ctx.userId)),
        )
        .limit(1);
      if (
        !callerMembership ||
        (callerMembership.role !== "owner" && callerMembership.role !== "admin")
      ) {
        return reply.status(403).send({ error: "not_admin" });
      }

      const [targetUser] = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, targetUserId))
        .limit(1);
      if (!targetUser) {
        return reply.status(404).send({ error: "user_not_found" });
      }

      const [existingBan] = await db
        .select({ id: roomBan.id })
        .from(roomBan)
        .where(and(eq(roomBan.roomId, roomId), eq(roomBan.userId, targetUserId)))
        .limit(1);
      if (existingBan) {
        return reply.status(409).send({ error: "already_banned" });
      }

      const [targetMembership] = await db
        .select({ role: roomMember.role })
        .from(roomMember)
        .where(
          and(eq(roomMember.roomId, roomId), eq(roomMember.userId, targetUserId)),
        )
        .limit(1);

      const wasMember = !!targetMembership;

      await db.transaction(async (tx) => {
        await tx.insert(roomBan).values({
          id: randomUUID(),
          roomId,
          userId: targetUserId,
          bannedById: ctx.userId,
          reason,
        });
        if (wasMember) {
          await tx
            .delete(roomMember)
            .where(
              and(
                eq(roomMember.roomId, roomId),
                eq(roomMember.userId, targetUserId),
              ),
            );
        }
      });

      const atIso = new Date().toISOString();
      if (wasMember) {
        // kick-path — emit `room.member.kicked` (not `banned`) because
        // clients already treat kicked as "leave now"; broadcasting both
        // would be redundant (spec §4 REQ-207).
        request.server.io.to(roomId).emit("room.member.kicked", {
          type: "room.member.kicked",
          roomId,
          userId: targetUserId,
          kickedBy: ctx.userId,
          kickedAt: atIso,
        });
        // REQ-208 — same `.local.socketsLeave` rationale as REQ-203 kick
        // (Redis adapter's non-local delSockets is fire-and-forget pub/sub).
        request.server.io.in(`user:${targetUserId}`).local.socketsLeave(roomId);
      } else {
        request.server.io.to(roomId).emit("room.member.banned", {
          type: "room.member.banned",
          roomId,
          userId: targetUserId,
          bannedBy: ctx.userId,
          reason,
          bannedAt: atIso,
        });
      }

      return reply.status(200).send({ banned: true, kicked: wasMember });
    },
  );

  // REQ-205 — DELETE /api/v1/rooms/:id/bans/:userId. Owner/admin removes an
  // active ban. Does NOT restore membership — target must POST /rooms/:id/join
  // again (existing S2 rooms handler). Emits `room.member.unbanned` to the
  // room channel so Manage Room → Banned tab updates live for other admins.
  app.delete<{ Params: { id: string; userId: string } }>(
    "/rooms/:id/bans/:userId",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const { id: roomId, userId: targetUserId } = request.params;

      const [target] = await db
        .select({ id: room.id })
        .from(room)
        .where(eq(room.id, roomId))
        .limit(1);
      if (!target) {
        return reply.status(404).send({ error: "room_not_found" });
      }

      const [callerMembership] = await db
        .select({ role: roomMember.role })
        .from(roomMember)
        .where(
          and(eq(roomMember.roomId, roomId), eq(roomMember.userId, ctx.userId)),
        )
        .limit(1);
      if (
        !callerMembership ||
        (callerMembership.role !== "owner" && callerMembership.role !== "admin")
      ) {
        return reply.status(403).send({ error: "not_admin" });
      }

      const deleteResult = await db
        .delete(roomBan)
        .where(and(eq(roomBan.roomId, roomId), eq(roomBan.userId, targetUserId)));
      if ((deleteResult.rowCount ?? 0) === 0) {
        return reply.status(404).send({ error: "ban_not_found" });
      }

      const unbannedAt = new Date().toISOString();
      request.server.io.to(roomId).emit("room.member.unbanned", {
        type: "room.member.unbanned",
        roomId,
        userId: targetUserId,
        unbannedBy: ctx.userId,
        unbannedAt,
      });

      return reply.status(200).send({ unbanned: true });
    },
  );

  // REQ-206 — GET /api/v1/rooms/:id/bans. Owner/admin only. Ordered by
  // bannedAt DESC. Joins `user` twice (target + actor) to resolve usernames
  // in a single query; no N+1. DB column `created_at` is aliased to
  // `bannedAt` on the wire per spec §5.
  app.get<{ Params: { id: string } }>(
    "/rooms/:id/bans",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const { id: roomId } = request.params;

      const [target] = await db
        .select({ id: room.id })
        .from(room)
        .where(eq(room.id, roomId))
        .limit(1);
      if (!target) {
        return reply.status(404).send({ error: "room_not_found" });
      }

      const [callerMembership] = await db
        .select({ role: roomMember.role })
        .from(roomMember)
        .where(
          and(eq(roomMember.roomId, roomId), eq(roomMember.userId, ctx.userId)),
        )
        .limit(1);
      if (
        !callerMembership ||
        (callerMembership.role !== "owner" && callerMembership.role !== "admin")
      ) {
        return reply.status(403).send({ error: "not_admin" });
      }

      const bannedByUser = aliasedTable(user, "banned_by_user");
      const rows = await db
        .select({
          userId: roomBan.userId,
          username: user.username,
          bannedById: roomBan.bannedById,
          bannedByUsername: bannedByUser.username,
          reason: roomBan.reason,
          bannedAt: roomBan.createdAt,
        })
        .from(roomBan)
        .innerJoin(user, eq(user.id, roomBan.userId))
        .innerJoin(bannedByUser, eq(bannedByUser.id, roomBan.bannedById))
        .where(eq(roomBan.roomId, roomId))
        .orderBy(desc(roomBan.createdAt));

      return reply.status(200).send({
        bans: rows.map((r) => ({
          ...r,
          bannedAt: r.bannedAt.toISOString(),
        })),
      });
    },
  );
}
