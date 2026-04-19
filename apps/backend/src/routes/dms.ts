// S2 DMs routes — binding spec docs/specs/s2-dms.md.
// REQ-060 precondition, REQ-061 find-or-create, REQ-062 parity (reuse of
// messages routes), REQ-063/064 membership shape, REQ-066 freeze read-time.
//
// Design: DMs are `room` rows with kind='dm' (ADR-0007). This file owns:
//   - POST /api/v1/dms           — find-or-create the 2-person room
//   - GET  /api/v1/dms           — list caller's DMs (R11)
// Message sends + history reuse `routes/messages.ts` — a DM roomId is just a
// room. The freeze predicate lives in `lib/dm-freeze.ts` and is injected into
// the send handler so DM sends return 409 dialog_frozen.

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { createDmSchema, type CreateDmInput } from "@ai-herders/shared/dto";
import {
  friendship,
  message,
  messageSeq,
  room,
  roomMember,
  user,
  userBlock,
  type Message,
} from "@ai-herders/shared/schema";
import type { DmFrozenReason, DmListItem } from "@ai-herders/shared/protocol";

import { auth } from "../auth";
import { db } from "../db";
import { toFetchHeaders } from "../lib/fetch-headers";
import { toMessagePayload } from "./messages";

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

interface DmAuthContext {
  userId: string;
}

async function requireDmAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<DmAuthContext | null> {
  const headers = toFetchHeaders(request);
  const session = await auth.api.getSession({ headers });
  if (!session) {
    reply.status(401).send({ error: "unauthorized" });
    return null;
  }
  return { userId: session.user.id };
}

// Canonicalize the DM pair — lower userId first, lexicographic sort. The same
// algorithm the caller uses client-side (if any ever does); keeping it in one
// place means `dmPairKey` collisions on ON CONFLICT are deterministic.
export function buildDmPairKey(a: string, b: string): string {
  const [low, high] = a < b ? [a, b] : [b, a];
  return `${low}:${high}`;
}

// REQ-060 + REQ-073 effect 4 — DM precondition. Returns `true` when the caller
// may DM the target (friends, neither side has blocked the other). Returns
// `false` on any gate failure. Target-existence is checked separately so the
// 403 branch does NOT collapse 404 into "unknown user" — §8 Q4 approved
// option (b): unknown target → 403 dm_not_allowed.
async function isDmAllowed(callerId: string, targetId: string): Promise<boolean> {
  // Normalized friendship pair.
  const [userAId, userBId] =
    callerId < targetId ? [callerId, targetId] : [targetId, callerId];

  const [friendRow] = await db
    .select({ id: friendship.id })
    .from(friendship)
    .where(and(eq(friendship.userAId, userAId), eq(friendship.userBId, userBId)))
    .limit(1);
  if (!friendRow) return false;

  const [blockRow] = await db
    .select({ id: userBlock.id })
    .from(userBlock)
    .where(
      or(
        and(eq(userBlock.byId, callerId), eq(userBlock.targetId, targetId)),
        and(eq(userBlock.byId, targetId), eq(userBlock.targetId, callerId)),
      ),
    )
    .limit(1);
  if (blockRow) return false;

  return true;
}

export async function dmsRoutes(app: FastifyInstance): Promise<void> {
  // R1 + R4 — POST /api/v1/dms (find-or-create)
  app.post(
    "/",
    { preHandler: zodBodyGuard(createDmSchema) },
    async (request, reply) => {
      const ctx = await requireDmAuth(request, reply);
      if (!ctx) return;

      const body = request.body as CreateDmInput;
      const targetId = body.userId;

      if (targetId === ctx.userId) {
        return reply.status(400).send({ error: "self_dm" });
      }

      // Q4(b) — unknown user collapses into dm_not_allowed. Target-exists
      // check runs BEFORE the friend/block lookups: if no target row, the
      // normalized pair joins against userA/userB FKs would be meaningless.
      const [targetRow] = await db
        .select({ id: user.id, deletedAt: user.deletedAt })
        .from(user)
        .where(eq(user.id, targetId))
        .limit(1);
      if (!targetRow || targetRow.deletedAt !== null) {
        return reply.status(403).send({ error: "dm_not_allowed" });
      }

      if (!(await isDmAllowed(ctx.userId, targetId))) {
        return reply.status(403).send({ error: "dm_not_allowed" });
      }

      const pairKey = buildDmPairKey(ctx.userId, targetId);

      // Find-half: an existing DM for the pair? 200 idempotent.
      const [existing] = await db
        .select({ id: room.id })
        .from(room)
        .where(and(eq(room.kind, "dm"), eq(room.dmPairKey, pairKey)))
        .limit(1);
      if (existing) {
        return reply.status(200).send({
          roomId: existing.id,
          kind: "dm",
          dmPairKey: pairKey,
        });
      }

      const newRoomId = randomUUID();
      // Insert path — ON CONFLICT on (dm_pair_key) WHERE kind='dm' handles
      // the concurrent-create race. If another tx got here first, the
      // INSERT RETURNING is empty; re-SELECT wins the idempotent 200.
      const created = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(room)
          .values({
            id: newRoomId,
            name: null,
            kind: "dm",
            visibility: "private",
            ownerId: null,
            dmPairKey: pairKey,
          })
          .onConflictDoNothing({
            target: room.dmPairKey,
            where: sql`${room.kind} = 'dm'`,
          })
          .returning({ id: room.id });

        const firstInsert = inserted[0];
        if (!firstInsert) {
          return null;
        }

        const actualRoomId = firstInsert.id;
        await tx.insert(roomMember).values([
          {
            id: randomUUID(),
            userId: ctx.userId,
            roomId: actualRoomId,
            role: "member",
          },
          {
            id: randomUUID(),
            userId: targetId,
            roomId: actualRoomId,
            role: "member",
          },
        ]);
        await tx
          .insert(messageSeq)
          .values({ roomId: actualRoomId })
          .onConflictDoNothing();
        return actualRoomId;
      });

      if (created === null) {
        // Lost the race — re-SELECT and return 200.
        const [raced] = await db
          .select({ id: room.id })
          .from(room)
          .where(and(eq(room.kind, "dm"), eq(room.dmPairKey, pairKey)))
          .limit(1);
        if (!raced) {
          // Extremely narrow — ON CONFLICT DO NOTHING returned empty yet
          // the row vanished before the re-SELECT. Fall through as 500.
          return reply.status(500).send({ error: "internal" });
        }
        return reply.status(200).send({
          roomId: raced.id,
          kind: "dm",
          dmPairKey: pairKey,
        });
      }

      return reply.status(201).send({
        roomId: created,
        kind: "dm",
        dmPairKey: pairKey,
      });
    },
  );

  // R11 — GET /api/v1/dms. Lists caller's DM rooms with counterpart + last
  // message + frozen state. Reason priority: user_deleted > blocked >
  // not_friends (§5).
  app.get("/", async (request, reply) => {
    const ctx = await requireDmAuth(request, reply);
    if (!ctx) return;

    // Rooms where the caller is a member AND kind='dm'.
    const callerMemberships = await db
      .select({ roomId: roomMember.roomId })
      .from(roomMember)
      .innerJoin(room, eq(room.id, roomMember.roomId))
      .where(and(eq(roomMember.userId, ctx.userId), eq(room.kind, "dm")));
    const roomIds = callerMemberships.map((r) => r.roomId);
    if (roomIds.length === 0) {
      return reply.status(200).send({ dms: [] });
    }

    // Counterpart memberships (everyone else in these rooms).
    const others = await db
      .select({
        roomId: roomMember.roomId,
        userId: roomMember.userId,
        username: user.username,
        name: user.name,
        deletedAt: user.deletedAt,
      })
      .from(roomMember)
      .innerJoin(user, eq(user.id, roomMember.userId))
      .where(
        and(
          inArray(roomMember.roomId, roomIds),
          sql`${roomMember.userId} <> ${ctx.userId}`,
        ),
      );
    const otherByRoom = new Map<
      string,
      { userId: string; username: string; name: string; deleted: boolean }
    >();
    for (const o of others) {
      otherByRoom.set(o.roomId, {
        userId: o.userId,
        username: o.username,
        name: o.name,
        deleted: o.deletedAt !== null,
      });
    }

    // Latest message per room. Simple N small subqueries — DM count per user
    // is bounded by friend count; no point paginating this in S2.
    const latestByRoom = new Map<string, Message | null>();
    for (const rid of roomIds) {
      const [row] = await db
        .select()
        .from(message)
        .where(eq(message.roomId, rid))
        .orderBy(desc(message.seq))
        .limit(1);
      latestByRoom.set(rid, row ?? null);
    }

    // Friendship + block snapshots for freeze evaluation. Pair keys allow
    // O(1) lookups per DM.
    const pairFriendships = new Set<string>();
    const myBlocks = new Set<string>();
    const blockedBy = new Set<string>();
    const otherIds = [...otherByRoom.values()].map((o) => o.userId);

    if (otherIds.length > 0) {
      // Friendships where caller is userA or userB with any of these others.
      const fships = await db
        .select({
          userAId: friendship.userAId,
          userBId: friendship.userBId,
        })
        .from(friendship)
        .where(
          or(
            and(
              eq(friendship.userAId, ctx.userId),
              inArray(friendship.userBId, otherIds),
            ),
            and(
              eq(friendship.userBId, ctx.userId),
              inArray(friendship.userAId, otherIds),
            ),
          ),
        );
      for (const f of fships) {
        pairFriendships.add(buildDmPairKey(f.userAId, f.userBId));
      }

      const outgoing = await db
        .select({ targetId: userBlock.targetId })
        .from(userBlock)
        .where(
          and(
            eq(userBlock.byId, ctx.userId),
            inArray(userBlock.targetId, otherIds),
          ),
        );
      for (const b of outgoing) myBlocks.add(b.targetId);

      const incoming = await db
        .select({ byId: userBlock.byId })
        .from(userBlock)
        .where(
          and(
            eq(userBlock.targetId, ctx.userId),
            inArray(userBlock.byId, otherIds),
          ),
        );
      for (const b of incoming) blockedBy.add(b.byId);
    }

    const items: DmListItem[] = roomIds.map((roomId) => {
      const other = otherByRoom.get(roomId);
      if (!other) {
        // Defensive — a DM room without a counterpart row shouldn't exist
        // once R3 is enforced, but don't crash the listing if it does.
        return {
          roomId,
          other: { userId: "", username: "", name: "", deleted: true },
          lastMessage: null,
          unreadCount: 0,
          frozen: true,
          frozenReason: "user_deleted" as DmFrozenReason,
        };
      }

      // Reason priority: user_deleted > blocked > not_friends.
      let frozen = false;
      let reason: DmFrozenReason | null = null;
      if (other.deleted) {
        frozen = true;
        reason = "user_deleted";
      } else if (myBlocks.has(other.userId) || blockedBy.has(other.userId)) {
        frozen = true;
        reason = "blocked";
      } else if (!pairFriendships.has(buildDmPairKey(ctx.userId, other.userId))) {
        frozen = true;
        reason = "not_friends";
      }

      const latest = latestByRoom.get(roomId) ?? null;
      const lastMessage = latest ? toMessagePayload(latest) : null;

      return {
        roomId,
        other,
        lastMessage,
        // TODO(hackathon): wire real unread count when s2-unread spec lands.
        unreadCount: 0,
        frozen,
        frozenReason: reason,
      };
    });

    // Order: latest message createdAt DESC, DMs with no messages at the end.
    items.sort((a, b) => {
      const aAt = a.lastMessage?.createdAt ?? "";
      const bAt = b.lastMessage?.createdAt ?? "";
      if (aAt === bAt) return 0;
      if (!aAt) return 1;
      if (!bAt) return -1;
      return aAt > bAt ? -1 : 1;
    });

    return reply.status(200).send({ dms: items });
  });
}
