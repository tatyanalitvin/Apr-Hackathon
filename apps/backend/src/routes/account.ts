// REQ-018 (v3.docx §2.2 "Account Removal") — DELETE /api/v1/users/me.
//
// Soft-delete the user row and hard-delete every relationship edge so live
// views (friends list, DM list, room member list) drop the account cleanly.
// Messages are preserved with `authorId` intact; the name substitution happens
// at serialization time via `lib/users.ts#formatUserDisplay`.
//
// Password re-auth gate: we take `{ password }` in the body and compare it
// against the stored hash via better-auth's `verifyPassword` helper. Cookie
// auth alone is NOT enough — the cascade is irreversible and a misplaced
// click shouldn't be able to wipe friendships, DMs, and room memberships.
//
// Why this supersedes `/api/auth/delete-user` (S1 task #11): better-auth's
// built-in path hard-deletes the user row, which would break message.authorId
// FKs and contradict v3.docx §2.2 ("messages remain visible after account
// removal"). `deleteUser.enabled` flips to false in auth.ts alongside this
// route so there's a single deletion path.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { deleteAccountSchema } from "@ai-herders/shared/dto";
import {
  account,
  attachment,
  friendRequest,
  friendship,
  message,
  room,
  roomMember,
  session,
  user,
  userBlock,
} from "@ai-herders/shared/schema";
import type {
  UserDataExport,
  UserDataExportAttachment,
  UserDataExportDm,
  UserDataExportMessage,
} from "@ai-herders/shared/protocol";

import { auth } from "../auth";
import { db } from "../db";
import { toFetchHeaders } from "../lib/fetch-headers";
import { formatUserDisplay } from "../lib/users";

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  // REQ-147 — tight cap on account delete + export. Both are expensive,
  // destructive (delete) or privacy-sensitive (export), and should never
  // fire more than a handful of times per hour per IP. Using IP as the
  // key (plugin default) rather than user ID because a hijacked session
  // reaching us from a single source should be clamped regardless of
  // which account it's driving.
  app.delete("/users/me", {
    config: {
      rateLimit: {
        max: 3,
        timeWindow: "1 hour",
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const headers = toFetchHeaders(request);
    const me = await auth.api.getSession({ headers });
    if (!me) {
      return reply.status(401).send({ error: "unauthorized" });
    }

    const parsed = deleteAccountSchema.safeParse(request.body);
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

    // Password re-auth via the credential `account` row. Return 401 (not 403)
    // on mismatch so the error surface matches "unauthorized to perform this
    // destructive op"; 400 is reserved for malformed bodies above.
    const [cred] = await db
      .select({ password: account.password })
      .from(account)
      .where(eq(account.userId, me.user.id))
      .limit(1);
    const hash = cred?.password;
    if (!hash) {
      return reply.status(401).send({ error: "unauthorized" });
    }
    const ok = await verifyPassword({ hash, password: parsed.data.password });
    if (!ok) {
      return reply.status(401).send({ error: "unauthorized" });
    }

    const userId = me.user.id;
    // Single transaction so a mid-cascade failure leaves the user row
    // un-stamped (caller can retry). Relationship tables use FK `onDelete:
    // cascade` to user.id, but the user row STAYS — so the relationship
    // cleanup can't ride the FK; we do it explicitly here.
    await db.transaction(async (tx) => {
      await tx
        .delete(friendship)
        .where(or(eq(friendship.userAId, userId), eq(friendship.userBId, userId)));
      await tx
        .delete(friendRequest)
        .where(or(eq(friendRequest.fromId, userId), eq(friendRequest.toId, userId)));
      await tx
        .delete(userBlock)
        .where(or(eq(userBlock.byId, userId), eq(userBlock.targetId, userId)));
      await tx.delete(roomMember).where(eq(roomMember.userId, userId));
      await tx.update(user).set({ deletedAt: new Date() }).where(eq(user.id, userId));
    });

    // Session revocation runs OUTSIDE the tx on purpose: better-auth caches
    // session tokens in Redis (secondary-storage) and a raw DB delete would
    // leave the Redis entry alive, so `getSession(cookie)` would keep
    // returning the stale session until the cache TTL. `revokeSessions`
    // clears both stores via internalAdapter.deleteSessions. Ordered after
    // the tx so the failure mode is "stamped but cookie still warm" (next
    // request fails at the deleted-account guard anyway) rather than
    // "sessions gone but user still active" (race where a concurrent
    // request sees no session and re-logs in before deletedAt lands).
    await auth.api.revokeSessions({ headers });

    return reply.status(204).send();
  });

  // REQ-126 / REQ-127 (v3.docx §2.2) — POST /api/v1/users/me/export.
  //
  // Assembles a UserDataExport manifest of everything the caller owns or
  // participates in, then serves it as a JSON download (attachment
  // Content-Disposition). Manifest, not archive: attachment rows are
  // referenced by id + originalName + sizeBytes; the bytes stay on disk
  // under UPLOAD_DIR. REQ-126 is portability of the user's content, and a
  // manifest is both cheaper to generate and compatible with how a future
  // UI would lazily fetch the files it actually wants to restore.
  app.post("/users/me/export", {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "1 hour",
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const headers = toFetchHeaders(request);
    const me = await auth.api.getSession({ headers });
    if (!me) {
      return reply.status(401).send({ error: "unauthorized" });
    }

    const userId = me.user.id;

    const [profile] = await db
      .select({
        id: user.id,
        email: user.email,
        username: user.username,
        createdAt: user.createdAt,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!profile) {
      return reply.status(401).send({ error: "unauthorized" });
    }

    // Rooms the caller is a member of (any kind). Return `kind` so the
    // client can distinguish DMs from group rooms without a second query.
    const memberships = await db
      .select({
        id: room.id,
        name: room.name,
        kind: room.kind,
        joinedAt: roomMember.joinedAt,
      })
      .from(roomMember)
      .innerJoin(room, eq(room.id, roomMember.roomId))
      .where(eq(roomMember.userId, userId))
      .orderBy(asc(roomMember.joinedAt));

    const groupRoomIds = memberships
      .filter((r) => r.kind === "group")
      .map((r) => r.id);
    const dmRoomIds = memberships.filter((r) => r.kind === "dm").map((r) => r.id);

    // Author'd messages across ALL rooms the caller was a member of. Split
    // into group-message list + DM-threads below. We scope to rooms we're
    // currently in (rather than `authorId=me` alone) so DM messages from
    // a DM the user has already left are filtered out — those counted as
    // "someone else's thread" once membership was gone.
    const authoredRows = memberships.length === 0
      ? []
      : await db
          .select({
            id: message.id,
            roomId: message.roomId,
            seq: message.seq,
            body: message.body,
            createdAt: message.createdAt,
            roomName: room.name,
          })
          .from(message)
          .innerJoin(room, eq(room.id, message.roomId))
          .where(
            and(
              eq(message.authorId, userId),
              inArray(
                message.roomId,
                memberships.map((m) => m.id),
              ),
            ),
          )
          .orderBy(asc(message.seq));

    // Attachment manifest per message (batched by messageId IN (...)).
    const authoredIds = authoredRows.map((m) => m.id);
    const attachmentRows = authoredIds.length === 0
      ? []
      : await db
          .select({
            id: attachment.id,
            messageId: attachment.messageId,
            originalName: attachment.originalName,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          })
          .from(attachment)
          .where(inArray(attachment.messageId, authoredIds));
    const attachmentsByMessage = new Map<string, UserDataExportAttachment[]>();
    for (const a of attachmentRows) {
      if (!a.messageId) continue;
      const arr = attachmentsByMessage.get(a.messageId) ?? [];
      arr.push({
        id: a.id,
        originalName: a.originalName,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      });
      attachmentsByMessage.set(a.messageId, arr);
    }

    function toExportMessage(row: typeof authoredRows[number]): UserDataExportMessage {
      return {
        id: row.id,
        roomId: row.roomId,
        roomName: row.roomName ?? "",
        seq: row.seq.toString(),
        body: row.body,
        createdAt: row.createdAt.toISOString(),
        attachments: attachmentsByMessage.get(row.id) ?? [],
      };
    }

    const groupRoomIdSet = new Set(groupRoomIds);
    const dmRoomIdSet = new Set(dmRoomIds);

    const groupMessages: UserDataExportMessage[] = authoredRows
      .filter((r) => groupRoomIdSet.has(r.roomId))
      .map(toExportMessage);

    // DM threads — group authored messages by roomId, then attach the peer
    // username via room_member + user (formatUserDisplay so a soft-deleted
    // peer shows up as "[deleted user]" rather than leaking their old
    // username). A DM has exactly two members; we pick the one ≠ caller.
    const dmPeerRows = dmRoomIds.length === 0
      ? []
      : await db
          .select({
            roomId: roomMember.roomId,
            peerUserId: user.id,
            peerUsername: user.username,
            peerName: user.name,
            peerDeletedAt: user.deletedAt,
          })
          .from(roomMember)
          .innerJoin(user, eq(user.id, roomMember.userId))
          .where(inArray(roomMember.roomId, dmRoomIds));
    const dmPeerByRoom = new Map<
      string,
      { username: string; name: string; deleted: boolean }
    >();
    for (const row of dmPeerRows) {
      if (row.peerUserId === userId) continue;
      const display = formatUserDisplay({
        username: row.peerUsername,
        name: row.peerName,
        deletedAt: row.peerDeletedAt,
      });
      dmPeerByRoom.set(row.roomId, display);
    }

    const dmByRoom = new Map<string, UserDataExportMessage[]>();
    for (const row of authoredRows) {
      if (!dmRoomIdSet.has(row.roomId)) continue;
      const arr = dmByRoom.get(row.roomId) ?? [];
      arr.push(toExportMessage(row));
      dmByRoom.set(row.roomId, arr);
    }
    const directMessages: UserDataExportDm[] = dmRoomIds.map((roomId) => ({
      dmId: roomId,
      peerUsername: dmPeerByRoom.get(roomId)?.username ?? "",
      messages: dmByRoom.get(roomId) ?? [],
    }));

    // Friendships — normalized pair table, caller can be on either side.
    // Same username-substitution rule as DM peers (REQ-018).
    const friendsAsA = await db
      .select({
        friendUsername: user.username,
        friendName: user.name,
        friendDeletedAt: user.deletedAt,
        since: friendship.createdAt,
      })
      .from(friendship)
      .innerJoin(user, eq(user.id, friendship.userBId))
      .where(eq(friendship.userAId, userId));
    const friendsAsB = await db
      .select({
        friendUsername: user.username,
        friendName: user.name,
        friendDeletedAt: user.deletedAt,
        since: friendship.createdAt,
      })
      .from(friendship)
      .innerJoin(user, eq(user.id, friendship.userAId))
      .where(eq(friendship.userBId, userId));
    const friendships = [...friendsAsA, ...friendsAsB].map((row) => {
      const display = formatUserDisplay({
        username: row.friendUsername,
        name: row.friendName,
        deletedAt: row.friendDeletedAt,
      });
      return {
        friendUsername: display.username,
        since: row.since.toISOString(),
      };
    });

    // Sessions — same allowlist as routes/sessions.ts (token is never
    // echoed). ipAddress + userAgent may be absent for older rows; only
    // userAgent is forwarded here per UserDataExport shape (the IP hash
    // lives in the metrics admin view, not the user-facing export).
    const sessionRows = await db
      .select({
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        userAgent: session.userAgent,
      })
      .from(session)
      .where(eq(session.userId, userId))
      .orderBy(asc(session.createdAt));

    const payload: UserDataExport = {
      exportedAt: new Date().toISOString(),
      user: {
        id: profile.id,
        email: profile.email,
        username: profile.username,
        createdAt: profile.createdAt.toISOString(),
      },
      rooms: memberships.map((r) => ({
        id: r.id,
        name: r.name ?? "",
        kind: r.kind,
        joinedAt: r.joinedAt.toISOString(),
      })),
      messages: groupMessages,
      directMessages,
      friendships,
      sessions: sessionRows.map((s) => ({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        lastActiveAt: s.updatedAt.toISOString(),
        ...(s.userAgent ? { userAgent: s.userAgent } : {}),
      })),
    };

    const filename = `user-data-export-${profile.username}-${Date.now()}.json`;
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    return reply.status(200).send(payload);
  });
}
