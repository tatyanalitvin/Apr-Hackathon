// Task #6a (REQ-017, v3.docx §2.2.4) — GET /api/v1/sessions.
//
// Thin wrapper over better-auth's auth.api.listSessions + getSession, with
// two value-adds we own (documented in docs/specs/s1-auth.md §10 task #6):
//   1. Strip `session.token` from every row. The token is auth-equivalent
//      (it IS the cookie value); echoing it back in JSON would defeat
//      HttpOnly. listSessions returns it; we mask at the boundary.
//   2. Tag the caller's own row with `current: true` by matching the token
//      returned from getSession. Lets the UI say "this browser".

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { session } from "@ai-herders/shared/schema";
import { auth } from "../auth";
import { db } from "../db";
import { toFetchHeaders } from "../lib/fetch-headers";

export async function sessionsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    const headers = toFetchHeaders(request);

    const me = await auth.api.getSession({ headers });
    if (!me) {
      return reply.status(401).send({ error: "unauthorized" });
    }

    const sessions = await auth.api.listSessions({ headers });
    const currentToken = me.session.token;

    // Allowlist, not spread. `token` is auth-equivalent and must never leave
    // the server — but `...rest` would also forward-leak any future fields
    // better-auth adds (e.g. plugin-only `impersonatedBy` in admin paths).
    // The shape here IS the contract R13 (v3.docx §2.2.4) promises the UI.
    return sessions.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      expiresAt: s.expiresAt,
      current: s.token === currentToken,
    }));
  });

  // Task #6b — ownership guard is ours, not better-auth's. We 403 for both
  // "belongs to someone else" and "doesn't exist" so session-id existence is
  // not a probe oracle. See spec §10 (2026-04-18 before task #6) entry.
  app.delete(
    "/:id",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const headers = toFetchHeaders(request);
      const me = await auth.api.getSession({ headers });
      if (!me) {
        return reply.status(401).send({ error: "unauthorized" });
      }

      const [row] = await db
        .select({ token: session.token, userId: session.userId })
        .from(session)
        .where(eq(session.id, request.params.id))
        .limit(1);

      if (!row || row.userId !== me.user.id) {
        return reply.status(403).send({ error: "forbidden" });
      }

      await auth.api.revokeSession({ headers, body: { token: row.token } });
      return reply.status(204).send();
    },
  );
}
