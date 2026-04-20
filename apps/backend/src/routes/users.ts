// User directory search — GET /api/v1/users?q=<term>.
// Binding spec: docs/specs/s3-user-search.md.
//
// Read-only module: ranking SQL + relationship enrichment + per-user rate
// limit. Kept separate from routes/friendship.ts because friendship.ts owns
// mutable graph state; a discovery endpoint with its own rate-limit bucket
// belongs in its own file (spec §5 "Why a new file").

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { userSearchQuerySchema } from "@ai-herders/shared/dto";

import { auth } from "../auth";
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

    // Filled in later tasks — ranking SQL + relationship enrichment.
    return reply.status(200).send({ users: [] });
  });
}
