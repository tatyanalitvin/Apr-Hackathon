// S2 invitations routes — REQ-089 / REQ-089a.
// Binding spec: docs/specs/s2-invitations.md §4 R3-R8.
//
// Endpoints (all mounted under /api/v1 via buildApp):
//   POST   /rooms/:id/invitations        — R3 send
//   GET    /invitations                  — R4 inbox (pending, non-expired)
//   POST   /invitations/:id/accept       — R5 accept (atomic: UPDATE + INSERT)
//   POST   /invitations/:id/decline      — R6 decline
//   DELETE /invitations/:id              — R7 inviter cancel (reuses 'declined')
//
// Fanout asymmetry (binding, see spec §4 R7): inviter-cancel fans out to
// invitee; invitee-decline fans out to inviter; invitee-accept fans out to
// inviter. Same event name `room.invitation.declined` for both decline paths,
// different audience.

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  room,
  roomBan,
  roomInvite,
  roomMember,
  user,
} from "@ai-herders/shared/schema";
import { createInvitationSchema } from "@ai-herders/shared/dto";

import { db } from "../db";
import { env } from "../env";
import { requireFriendshipAuth } from "./friendship";

// REQ-089 startup probe — §5 cross-agent coordination. If the flag is on but
// the `room_ban` relation is missing (agent A's 0007 slipped), log a warning
// and downgrade to "flag off" at runtime so the invitee-banned SELECT is
// skipped rather than exploding. Probed once at register-time via a lightweight
// `to_regclass` lookup; the result caches for the lifetime of the Fastify
// instance (tests rebuild buildApp per-suite, so the probe reruns between
// suites, which is the behaviour we want).
async function probeRoomBan(): Promise<boolean> {
  if (!env.INVITATIONS_ENFORCE_BAN) return false;
  const result = await db.execute<{ regclass: string | null }>(
    sql`SELECT to_regclass('public.room_ban')::text AS regclass`,
  );
  const rows = (result as unknown as { rows: Array<{ regclass: string | null }> }).rows ?? [];
  const present = Array.isArray(rows) && rows.length > 0 && rows[0]?.regclass != null;
  return present;
}

export async function invitationsRoutes(app: FastifyInstance): Promise<void> {
  const enforceBan = await probeRoomBan();
  if (env.INVITATIONS_ENFORCE_BAN && !enforceBan) {
    app.log.warn(
      "INVITATIONS_ENFORCE_BAN=true but room_ban relation missing; " +
        "skipping 403 invitee_banned branch (agent A 0007 not yet landed).",
    );
  }

  // ─── R3 / REQ-089 — POST /rooms/:id/invitations ─────────────────────────
  app.post<{ Params: { id: string } }>(
    "/rooms/:id/invitations",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const parsed = createInvitationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "invalid_body", details: parsed.error.flatten() });
      }
      const { inviteeUsername } = parsed.data;
      const roomId = request.params.id;

      // Ordering (spec §4 R3): 404 room → 403 not_a_member → (private) 403
      // forbidden_role → 404 invitee_not_found → 409 already_member →
      // 403 banned → 409 pending → INSERT.
      const [targetRoom] = await db
        .select({
          id: room.id,
          name: room.name,
          kind: room.kind,
          visibility: room.visibility,
          deletedAt: room.deletedAt,
        })
        .from(room)
        .where(eq(room.id, roomId))
        .limit(1);
      if (!targetRoom || targetRoom.deletedAt != null) {
        return reply.status(404).send({ error: "room_not_found" });
      }

      const [membership] = await db
        .select({ role: roomMember.role })
        .from(roomMember)
        .where(
          and(eq(roomMember.roomId, roomId), eq(roomMember.userId, ctx.userId)),
        )
        .limit(1);
      if (!membership) {
        return reply.status(403).send({ error: "not_a_member" });
      }

      // Approved Q1 divergence from REQ-089b: public-room members MAY invite;
      // the owner/admin gate applies only to private rooms. Logged in
      // FOLLOWUPS.md at merge.
      if (targetRoom.visibility === "private") {
        if (membership.role !== "owner" && membership.role !== "admin") {
          return reply.status(403).send({ error: "forbidden_role" });
        }
      }

      const [invitee] = await db
        .select({ id: user.id, username: user.username })
        .from(user)
        .where(eq(user.username, inviteeUsername))
        .limit(1);
      if (!invitee) {
        return reply.status(404).send({ error: "invitee_not_found" });
      }

      const [existingMembership] = await db
        .select({ id: roomMember.id })
        .from(roomMember)
        .where(
          and(eq(roomMember.roomId, roomId), eq(roomMember.userId, invitee.id)),
        )
        .limit(1);
      if (existingMembership) {
        return reply.status(409).send({ error: "invitee_already_member" });
      }

      if (enforceBan) {
        const [ban] = await db
          .select({ id: roomBan.id })
          .from(roomBan)
          .where(and(eq(roomBan.roomId, roomId), eq(roomBan.userId, invitee.id)))
          .limit(1);
        if (ban) {
          return reply.status(403).send({ error: "invitee_banned" });
        }
      }

      // REQ-089a R8 — the partial unique index `(room_id, invitee_id) WHERE
      // status='pending'` can't reference `now()` (volatile; forbidden in
      // partial index predicates), so an expired-but-still-'pending' row
      // would block a fresh INSERT with a constraint violation even though
      // R3 semantics say expired rows must not block. Resolve both cases by
      // reading the single `status='pending'` row (if any) and either
      // rejecting (live) or lazy-flipping it to 'expired' (stale). This is
      // the same effect the REQ-157 GC sweep would produce, just at
      // write-time instead of on a timer. Atomic-enough: the partial unique
      // guarantees at most one such row exists, so no sweep loop is needed.
      const [pendingRow] = await db
        .select({ id: roomInvite.id, expiresAt: roomInvite.expiresAt })
        .from(roomInvite)
        .where(
          and(
            eq(roomInvite.roomId, roomId),
            eq(roomInvite.inviteeId, invitee.id),
            eq(roomInvite.status, "pending"),
          ),
        )
        .limit(1);
      if (pendingRow) {
        if (pendingRow.expiresAt > new Date()) {
          return reply.status(409).send({ error: "invite_pending" });
        }
        await db
          .update(roomInvite)
          .set({ status: "expired" })
          .where(eq(roomInvite.id, pendingRow.id));
      }

      const invitationId = randomUUID();
      const [created] = await db
        .insert(roomInvite)
        .values({
          id: invitationId,
          roomId,
          inviterId: ctx.userId,
          inviteeId: invitee.id,
          status: "pending",
        })
        .returning();
      if (!created) {
        return reply.status(500).send({ error: "invite_insert_failed" });
      }

      // Best-effort at-most-once fanout to the invitee's per-user channel.
      // Emit AFTER the INSERT commits so a rollback can't leak a phantom event.
      request.server.io.to(`user:${invitee.id}`).emit("room.invitation.sent", {
        type: "room.invitation.sent",
        invitationId: created.id,
        roomId: targetRoom.id,
        roomName: targetRoom.name,
        inviterId: ctx.userId,
        inviterUsername: ctx.username,
        createdAt: created.createdAt.toISOString(),
        expiresAt: created.expiresAt.toISOString(),
      });

      return reply.status(201).send({
        invitationId: created.id,
        expiresAt: created.expiresAt.toISOString(),
      });
    },
  );

  // ─── R4 / REQ-089 — GET /invitations (inbox) ───────────────────────────
  app.get("/invitations", async (request, reply) => {
    const ctx = await requireFriendshipAuth(request, reply);
    if (!ctx) return;

    const rows = await db
      .select({
        id: roomInvite.id,
        roomId: roomInvite.roomId,
        roomName: room.name,
        inviterUsername: user.username,
        createdAt: roomInvite.createdAt,
        expiresAt: roomInvite.expiresAt,
      })
      .from(roomInvite)
      .innerJoin(room, eq(room.id, roomInvite.roomId))
      .innerJoin(user, eq(user.id, roomInvite.inviterId))
      .where(
        and(
          eq(roomInvite.inviteeId, ctx.userId),
          eq(roomInvite.status, "pending"),
          gt(roomInvite.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(roomInvite.createdAt));

    return reply.status(200).send({
      invitations: rows.map((r) => ({
        id: r.id,
        roomId: r.roomId,
        roomName: r.roomName,
        inviterUsername: r.inviterUsername,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      })),
    });
  });

  // ─── R5 / REQ-089 — POST /invitations/:id/accept ───────────────────────
  // Atomic transaction: UPDATE invite → INSERT room_member. The forced-
  // rollback test in invitations-accept.test.ts spies on roomMember.insert
  // and throws, asserting the invite row remains 'pending' (no half-state).
  app.post<{ Params: { id: string } }>(
    "/invitations/:id/accept",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const invitationId = request.params.id;
      const [invite] = await db
        .select({
          id: roomInvite.id,
          roomId: roomInvite.roomId,
          inviterId: roomInvite.inviterId,
          inviteeId: roomInvite.inviteeId,
          status: roomInvite.status,
          expiresAt: roomInvite.expiresAt,
        })
        .from(roomInvite)
        .where(eq(roomInvite.id, invitationId))
        .limit(1);
      if (!invite) {
        return reply.status(404).send({ error: "invitation_not_found" });
      }
      if (invite.inviteeId !== ctx.userId) {
        return reply.status(403).send({ error: "not_invitee" });
      }
      if (invite.status !== "pending" || invite.expiresAt <= new Date()) {
        return reply.status(409).send({ error: "invitation_not_pending" });
      }

      const acceptedAt = new Date();
      await db.transaction(async (tx) => {
        await tx
          .update(roomInvite)
          .set({ status: "accepted", respondedAt: acceptedAt })
          .where(eq(roomInvite.id, invite.id));
        await tx
          .insert(roomMember)
          .values({
            id: randomUUID(),
            roomId: invite.roomId,
            userId: ctx.userId,
            role: "member",
            joinedAt: acceptedAt,
          })
          .onConflictDoNothing({
            target: [roomMember.userId, roomMember.roomId],
          });
      });

      // Post-commit fanout. R5 §4: inviter notified via per-user channel;
      // room channel gets the existing `room.member.joined` so s1 handlers
      // (presence, sidebar counts) see the new body.
      request.server.io
        .to(`user:${invite.inviterId}`)
        .emit("room.invitation.accepted", {
          type: "room.invitation.accepted",
          invitationId: invite.id,
          roomId: invite.roomId,
          inviteeId: ctx.userId,
          inviteeUsername: ctx.username,
          acceptedAt: acceptedAt.toISOString(),
        });
      request.server.io.to(invite.roomId).emit("room.member.joined", {
        type: "room.member.joined",
        roomId: invite.roomId,
        userId: ctx.userId,
        username: ctx.username,
        joinedAt: acceptedAt.toISOString(),
      });

      return reply.status(200).send({ joined: true, roomId: invite.roomId });
    },
  );

  // ─── R6 / REQ-089 — POST /invitations/:id/decline ──────────────────────
  app.post<{ Params: { id: string } }>(
    "/invitations/:id/decline",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const [invite] = await db
        .select({
          id: roomInvite.id,
          roomId: roomInvite.roomId,
          inviterId: roomInvite.inviterId,
          inviteeId: roomInvite.inviteeId,
          status: roomInvite.status,
        })
        .from(roomInvite)
        .where(eq(roomInvite.id, request.params.id))
        .limit(1);
      if (!invite) {
        return reply.status(404).send({ error: "invitation_not_found" });
      }
      if (invite.inviteeId !== ctx.userId) {
        return reply.status(403).send({ error: "not_invitee" });
      }
      if (invite.status !== "pending") {
        return reply.status(409).send({ error: "invitation_not_pending" });
      }

      const declinedAt = new Date();
      await db
        .update(roomInvite)
        .set({ status: "declined", respondedAt: declinedAt })
        .where(eq(roomInvite.id, invite.id));

      // R6 fanout: INVITER channel (inviter learns of the decline). §4 R7's
      // cancel path emits the same event to the INVITEE channel — spec §4 R7
      // documents the asymmetry as binding.
      request.server.io
        .to(`user:${invite.inviterId}`)
        .emit("room.invitation.declined", {
          type: "room.invitation.declined",
          invitationId: invite.id,
          roomId: invite.roomId,
          declinedAt: declinedAt.toISOString(),
        });

      return reply.status(200).send({ declined: true });
    },
  );

  // ─── R7 / REQ-089 — DELETE /invitations/:id (inviter cancel) ───────────
  app.delete<{ Params: { id: string } }>(
    "/invitations/:id",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const [invite] = await db
        .select({
          id: roomInvite.id,
          roomId: roomInvite.roomId,
          inviterId: roomInvite.inviterId,
          inviteeId: roomInvite.inviteeId,
          status: roomInvite.status,
        })
        .from(roomInvite)
        .where(eq(roomInvite.id, request.params.id))
        .limit(1);
      if (!invite) {
        return reply.status(404).send({ error: "invitation_not_found" });
      }
      if (invite.inviterId !== ctx.userId) {
        return reply.status(403).send({ error: "not_inviter" });
      }
      if (invite.status !== "pending") {
        return reply.status(409).send({ error: "invitation_not_pending" });
      }

      const declinedAt = new Date();
      await db
        .update(roomInvite)
        .set({ status: "declined", respondedAt: declinedAt })
        .where(eq(roomInvite.id, invite.id));

      // Asymmetry (§4 R7 binding): inviter-cancel → INVITEE channel so
      // Bob's inbox drops the row. Reuses the same event name as R6 with
      // inverted audience.
      request.server.io
        .to(`user:${invite.inviteeId}`)
        .emit("room.invitation.declined", {
          type: "room.invitation.declined",
          invitationId: invite.id,
          roomId: invite.roomId,
          declinedAt: declinedAt.toISOString(),
        });

      return reply.status(200).send({ cancelled: true });
    },
  );

  // Placate TS's unused-import warning when future features shrink the
  // imports. inArray is reserved for the batched-decline sweep (REQ-157 GC).
  void inArray;
}
