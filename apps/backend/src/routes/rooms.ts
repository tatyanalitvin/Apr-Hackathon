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
import { eq } from "drizzle-orm";
import { room, roomMember } from "@ai-herders/shared/schema";

import { db } from "../db";
import { requireFriendshipAuth } from "./friendship";

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

      // ON CONFLICT on the (user_id, room_id) unique index — insert is a
      // no-op when a membership already exists. rowCount distinguishes the
      // fresh-insert happy path from the idempotent-repeat no-op.
      const insertResult = await db
        .insert(roomMember)
        .values({
          id: randomUUID(),
          userId: ctx.userId,
          roomId: target.id,
        })
        .onConflictDoNothing({
          target: [roomMember.userId, roomMember.roomId],
        });
      const joined = (insertResult.rowCount ?? 0) > 0;

      return reply.status(200).send({ joined });
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
