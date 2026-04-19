// S2 rooms routes — REQ-025 (catalog), REQ-026 (self-join), plus non-v4
// /rooms/me caller-memberships endpoint.
// Binding spec: docs/specs/s2-rooms.md. See §4 R2/R3/R4 for the REST surface
// and §5 for rate-limit ordering.
//
// Auth pattern mirrors routes/friendship.ts — reuse requireFriendshipAuth
// (cross-feature; neither route family requires room membership). Each
// handler lands one-per-commit via TDD.

import type { FastifyInstance } from "fastify";

import { requireFriendshipAuth } from "./friendship";

export async function roomsRoutes(app: FastifyInstance): Promise<void> {
  // R2 / REQ-026 — POST /api/v1/rooms/:id/join (scaffolded; filled in per TDD)
  app.post<{ Params: { id: string } }>(
    "/rooms/:id/join",
    async (request, reply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;
      return reply.status(501).send({ error: "not_implemented" });
    },
  );

  // R3 / REQ-025 — GET /api/v1/rooms
  app.get("/rooms", async (request, reply) => {
    const ctx = await requireFriendshipAuth(request, reply);
    if (!ctx) return;
    return reply.status(501).send({ error: "not_implemented" });
  });

  // R4 (non-v4, see ADR-0006) — GET /api/v1/rooms/me
  app.get("/rooms/me", async (request, reply) => {
    const ctx = await requireFriendshipAuth(request, reply);
    if (!ctx) return;
    return reply.status(501).send({ error: "not_implemented" });
  });
}
