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
import { eq, or } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { deleteAccountSchema } from "@ai-herders/shared/dto";
import {
  account,
  friendRequest,
  friendship,
  roomMember,
  user,
  userBlock,
} from "@ai-herders/shared/schema";

import { auth } from "../auth";
import { db } from "../db";
import { toFetchHeaders } from "../lib/fetch-headers";

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.delete("/users/me", async (request: FastifyRequest, reply: FastifyReply) => {
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
}
