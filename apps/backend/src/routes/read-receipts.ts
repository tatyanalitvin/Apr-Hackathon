// REQ-120 — POST /api/v1/rooms/:id/read.
//
// Client signals "I've caught up to lastReadSeq" whenever the room is focused
// and scrolled to the bottom (see web/src/lib/use-mark-read.ts). Backend stores
// whatever the caller sends; we trust the client (no "is the caller actually
// caught up" check — nothing to exploit, brief §3 pre-resolved Q2).
//
// Rate-limit: 120/min/user. Intentionally liberal — debounce is 500ms on the
// web side but focus/scroll events can still flap. Own Redis client + key
// prefix so bursts here don't bleed into friend-req / room-create buckets.
//
// Auth reuses `requireFriendshipAuth` for the cookie → userId resolution and
// follows `requireRoomMember`'s 401/403 split: 401 for no cookie, 403 for
// "not a member" OR "room does not exist" (identical status so the route
// can't be used as a room-id enumeration oracle).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { createClient, type RedisClientType } from "redis";
import { markRoomReadSchema } from "@ai-herders/shared/dto";
import { roomMember } from "@ai-herders/shared/schema";

import { db } from "../db";
import { env } from "../env";
import { requireFriendshipAuth } from "./friendship";

const READ_RATE_WINDOW_SECONDS = 60;
const READ_RATE_LIMIT = 120;

let readRateClient: RedisClientType | undefined;

async function getReadRateClient(): Promise<RedisClientType> {
  if (!readRateClient) {
    const c: RedisClientType = createClient({ url: env.REDIS_URL });
    c.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[read-receipts-rate-limit] redis error:", err);
    });
    await c.connect();
    readRateClient = c;
  }
  return readRateClient;
}

async function checkReadRateLimit(
  userId: string,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const c = await getReadRateClient();
  const key = `rate:room-read:${userId}`;
  const count = await c.incr(key);
  if (count === 1) {
    await c.expire(key, READ_RATE_WINDOW_SECONDS);
  }
  if (count <= READ_RATE_LIMIT) {
    return { allowed: true, retryAfterSec: 0 };
  }
  const ttl = await c.ttl(key);
  return {
    allowed: false,
    retryAfterSec: ttl > 0 ? ttl : READ_RATE_WINDOW_SECONDS,
  };
}

export async function readReceiptsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>(
    "/:id/read",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ctx = await requireFriendshipAuth(request, reply);
      if (!ctx) return;

      // Rate-limit BEFORE membership resolution so ID-probing still burns the
      // bucket (same rationale as rooms.ts join / patch / delete).
      const rl = await checkReadRateLimit(ctx.userId);
      if (!rl.allowed) {
        return reply
          .status(429)
          .send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      }

      const parsed = markRoomReadSchema.safeParse(request.body);
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
      const result = await db
        .update(roomMember)
        .set({ lastReadSeq: parsed.data.lastReadSeq })
        .where(
          and(
            eq(roomMember.roomId, roomId),
            eq(roomMember.userId, ctx.userId),
          ),
        );

      // rowCount 0 ⇒ no membership row (either unknown room or non-member).
      // Merged into a single 403 to avoid leaking room-existence via oracle.
      if ((result.rowCount ?? 0) === 0) {
        return reply.status(403).send({ error: "forbidden" });
      }

      return reply.status(200).send({
        roomId,
        lastReadSeq: parsed.data.lastReadSeq.toString(),
      });
    },
  );
}
