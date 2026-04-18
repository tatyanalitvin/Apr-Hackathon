// Shared auth+membership gate for /api/v1/rooms/:id/messages routes.
// Mirrors the session-extraction pattern from routes/sessions.ts:21-22 and
// adds a room_member (userId, roomId) lookup.
//
// Returns null AFTER having sent the 401/403 reply so callers can:
//   const ctx = await requireRoomMember(request, reply, roomId);
//   if (!ctx) return;
//
// 403 is used for both "not a member" and "room does not exist" so this
// endpoint cannot be used as a room-id enumeration oracle (same rationale
// as routes/sessions.ts:45-47 for session IDs).

import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { roomMember } from "@ai-herders/shared/schema";

import { auth } from "../auth";
import { db } from "../db";
import { toFetchHeaders } from "./fetch-headers";

export interface MessageAuthContext {
  userId: string;
  username: string;
  name: string;
}

export async function requireRoomMember(
  request: FastifyRequest,
  reply: FastifyReply,
  roomId: string,
): Promise<MessageAuthContext | null> {
  const headers = toFetchHeaders(request);
  const session = await auth.api.getSession({ headers });
  if (!session) {
    reply.status(401).send({ error: "unauthorized" });
    return null;
  }

  const userId = session.user.id;
  const [membership] = await db
    .select({ id: roomMember.id })
    .from(roomMember)
    .where(and(eq(roomMember.roomId, roomId), eq(roomMember.userId, userId)))
    .limit(1);

  if (!membership) {
    reply.status(403).send({ error: "forbidden" });
    return null;
  }

  // better-auth additionalField; cast is safe — auth.ts registers
  // `username: required` on user.additionalFields so it's always present.
  const username = (session.user as { username?: string }).username ?? "";
  return { userId, username, name: session.user.name };
}
