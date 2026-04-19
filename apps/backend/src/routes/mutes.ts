// REQ-123 — PUT /api/v1/rooms/:id/mute.
//
// Sets `room_member.mutedUntil` for the caller. ISO timestamp = muted until
// that moment. null = unmuted. Past timestamps are NOT normalised server-side:
// the unread hook on the web reads mutedUntil and compares to now(), so stale
// values drift to "effectively unmuted" without a sweeper (brief §1a).
//
// Rate-limit 30/min/user. Auth + member/non-member handling matches the
// read-receipts route: 401 for no cookie, 403 for "not a member OR unknown
// room" (no oracle), 400 for malformed body, 429 on rate-limit overflow.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { createClient, type RedisClientType } from "redis";
import { muteRoomSchema } from "@ai-herders/shared/dto";
import { roomMember } from "@ai-herders/shared/schema";

import { db } from "../db";
import { env } from "../env";
import { requireFriendshipAuth } from "./friendship";

const MUTE_RATE_WINDOW_SECONDS = 60;
const MUTE_RATE_LIMIT = 30;

let muteRateClient: RedisClientType | undefined;

async function getMuteRateClient(): Promise<RedisClientType> {
  if (!muteRateClient) {
    const c: RedisClientType = createClient({ url: env.REDIS_URL });
    c.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[mutes-rate-limit] redis error:", err);
    });
    await c.connect();
    muteRateClient = c;
  }
  return muteRateClient;
}

async function checkMuteRateLimit(
  userId: string,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const c = await getMuteRateClient();
  const key = `rate:room-mute:${userId}`;
  const count = await c.incr(key);
  if (count === 1) {
    await c.expire(key, MUTE_RATE_WINDOW_SECONDS);
  }
  if (count <= MUTE_RATE_LIMIT) {
    return { allowed: true, retryAfterSec: 0 };
  }
  const ttl = await c.ttl(key);
  return {
    allowed: false,
    retryAfterSec: ttl > 0 ? ttl : MUTE_RATE_WINDOW_SECONDS,
  };
}

export async function mutesRoutes(app: FastifyInstance): Promise<void> {
  app.put<{ Params: { id: string } }>(
    "/:id/mute",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      const rl = await checkMuteRateLimit(ctx.userId);
      if (!rl.allowed) {
        return reply
          .status(429)
          .send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      }

      const parsed = muteRoomSchema.safeParse(request.body);
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

      const roomId = request.params.id;
      const nextValue =
        parsed.data.mutedUntil === null ? null : new Date(parsed.data.mutedUntil);

      const result = await db
        .update(roomMember)
        .set({ mutedUntil: nextValue })
        .where(
          and(
            eq(roomMember.roomId, roomId),
            eq(roomMember.userId, ctx.userId),
          ),
        );

      if ((result.rowCount ?? 0) === 0) {
        return reply.status(403).send({ error: "forbidden" });
      }

      return reply.status(200).send({
        roomId,
        mutedUntil: nextValue === null ? null : nextValue.toISOString(),
      });
    },
  );
}
