// User directory search — GET /api/v1/users?q=<term>.
// Binding spec: docs/specs/s3-user-search.md.
//
// Read-only module: ranking SQL + relationship enrichment + per-user rate
// limit. Kept separate from routes/friendship.ts because friendship.ts owns
// mutable graph state; a discovery endpoint with its own rate-limit bucket
// belongs in its own file (spec §5 "Why a new file").

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, ilike, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { userSearchQuerySchema } from "@ai-herders/shared/dto";
import { friendRequest, friendship, user, userBlock } from "@ai-herders/shared/schema";
import type { UserRelationship, UserSearchHit } from "@ai-herders/shared/protocol";

import { auth } from "../auth";
import { db } from "../db";
import { toFetchHeaders } from "../lib/fetch-headers";

interface UserSearchAuthContext {
  userId: string;
}

async function requireUserSearchAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<UserSearchAuthContext | null> {
  const headers = toFetchHeaders(request);
  const session = await auth.api.getSession({ headers });
  if (!session) {
    reply.status(401).send({ error: "unauthorized" });
    return null;
  }
  return { userId: session.user.id };
}

interface UserSearchRow {
  id: string;
  username: string;
  name: string;
}

async function searchUsers(
  callerId: string,
  q: string,
): Promise<UserSearchRow[]> {
  // Escape ILIKE metacharacters so user-supplied `%` and `_` are literal.
  // Postgres ILIKE uses `\` as the default escape character, so we prefix
  // each `\`, `%`, `_` with `\`. Keep `q` unescaped for exact `=` arms.
  const escaped = q.replace(/[\\%_]/g, "\\$&");

  // Ranking SQL — CASE expression drives ORDER BY. Tiebreak is username ASC.
  // Exact-match arms use `q` (no wildcards needed).
  // Prefix/substring arms use `escaped` so metacharacters are literal.
  const rankExpr = sql<number>`CASE
    WHEN ${user.username} = ${q} THEN 0
    WHEN ${user.name}     = ${q} THEN 1
    WHEN ${user.username} ILIKE ${escaped + "%"} THEN 2
    WHEN ${user.name}     ILIKE ${escaped + "%"} THEN 3
    WHEN ${user.username} ILIKE ${"%" + escaped + "%"} THEN 4
    ELSE 5
  END`;

  // Exclude users the caller blocked …
  const blockedByCaller = db
    .select({ id: userBlock.targetId })
    .from(userBlock)
    .where(eq(userBlock.byId, callerId));
  // … and users who have blocked the caller.
  const blockedCaller = db
    .select({ id: userBlock.byId })
    .from(userBlock)
    .where(eq(userBlock.targetId, callerId));

  const rows = await db
    .select({
      id: user.id,
      username: user.username,
      name: user.name,
      rank: rankExpr,
    })
    .from(user)
    .where(
      and(
        isNull(user.deletedAt),
        ne(user.id, callerId),
        or(
          ilike(user.username, `%${escaped}%`),
          ilike(user.name, `%${escaped}%`),
        ),
        notInArray(user.id, blockedByCaller),
        notInArray(user.id, blockedCaller),
      ),
    )
    .orderBy(rankExpr, user.username)
    .limit(20);

  return rows.map(({ rank: _rank, ...rest }) => rest);
}

async function resolveRelationships(
  callerId: string,
  hitIds: string[],
): Promise<Map<string, UserRelationship>> {
  const out = new Map<string, UserRelationship>();
  if (hitIds.length === 0) return out;

  // 1. Friendships where caller is A or B and the counterpart is a hit.
  const fships = await db
    .select({ userA: friendship.userAId, userB: friendship.userBId })
    .from(friendship)
    .where(
      or(
        and(eq(friendship.userAId, callerId), inArray(friendship.userBId, hitIds)),
        and(eq(friendship.userBId, callerId), inArray(friendship.userAId, hitIds)),
      ),
    );
  for (const row of fships) {
    const other = row.userA === callerId ? row.userB : row.userA;
    out.set(other, "friend");
  }

  // 2. Pending requests in either direction — friend (already set) wins.
  const requests = await db
    .select({ fromId: friendRequest.fromId, toId: friendRequest.toId })
    .from(friendRequest)
    .where(
      and(
        eq(friendRequest.status, "pending"),
        or(
          and(eq(friendRequest.fromId, callerId), inArray(friendRequest.toId, hitIds)),
          and(eq(friendRequest.toId, callerId), inArray(friendRequest.fromId, hitIds)),
        ),
      ),
    );
  for (const row of requests) {
    const other = row.fromId === callerId ? row.toId : row.fromId;
    if (out.has(other)) continue; // friend precedence (R16)
    out.set(other, row.fromId === callerId ? "request_outgoing" : "request_incoming");
  }

  return out;
}

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get("/users", async (request, reply) => {
    const ctx = await requireUserSearchAuth(request, reply);
    if (!ctx) return;

    // R1 — parse first, then re-trim. Whitespace-only survives the zod
    // .min(2) because whitespace is still 2+ chars; catch it post-trim.
    const parsed = userSearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_query" });
    }
    const q = parsed.data.q.trim();
    if (q.length < 2) {
      return reply.status(400).send({ error: "invalid_query" });
    }

    const rows = await searchUsers(ctx.userId, q);
    if (rows.length === 0) {
      return reply.status(200).send({ users: [] });
    }

    const hitIds = rows.map((r) => r.id);
    const relationshipByUser = await resolveRelationships(ctx.userId, hitIds);

    const users: UserSearchHit[] = rows.map((r) => ({
      userId: r.id,
      username: r.username,
      name: r.name,
      relationship: relationshipByUser.get(r.id) ?? "none",
    }));

    return reply.status(200).send({ users });
  });
}
