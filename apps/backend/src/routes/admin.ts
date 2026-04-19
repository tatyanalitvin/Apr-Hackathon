// REQ-158 — admin dashboard routes. Judges see these at /admin on the
// web app; this file is the sole backend surface (see S3_ADMIN brief).
//
// Auth: 401 if no session, 403 if session.user.id is NOT in the
// ADMIN_USER_IDS CSV. The list is read from process.env at REQUEST TIME
// (not cached from env.ts) so the hackathon operator can rotate admins
// without a backend restart — the typical flow is `docker compose up`
// with the var set, then re-exec the container if changing it.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AdminMetricsSnapshot } from "@ai-herders/shared/protocol";
import { auth } from "../auth";
import { toFetchHeaders } from "../lib/fetch-headers";
import { snapshotMetrics } from "../lib/metrics";

function parseAdminIds(csv: string | undefined): Set<string> {
  if (!csv) return new Set();
  return new Set(
    csv
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ userId: string } | null> {
  const headers = toFetchHeaders(request);
  const session = await auth.api.getSession({ headers });
  if (!session) {
    reply.status(401).send({ error: "unauthorized" });
    return null;
  }
  const admins = parseAdminIds(process.env.ADMIN_USER_IDS);
  if (!admins.has(session.user.id)) {
    reply.status(403).send({ error: "forbidden" });
    return null;
  }
  return { userId: session.user.id };
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async (request, reply) => {
    const ctx = await requireAdmin(request, reply);
    if (!ctx) return;
    const snap: AdminMetricsSnapshot = snapshotMetrics();
    return reply.status(200).send(snap);
  });
}
