// REQ-075/077/078/079/081/082/083 — attachment upload + download endpoints.
//
// Two-step flow: client POSTs the file (orphan attachment row, messageId NULL)
// then references the returned id in `attachmentIds` on the next message send
// (linked inside the existing transaction at routes/messages.ts).
//
// Auth + membership reuses requireRoomMember from lib/message-auth so the
// attachment surface inherits the S1 oracle-suppression behaviour (403 covers
// both "not a member" and "room does not exist").

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { requireRoomMember } from "../lib/message-auth";

export async function attachmentsRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/",
    async (request: FastifyRequest, reply: FastifyReply) => {
      // The membership check needs roomId; without a multipart body it can't
      // resolve yet. Real implementation lands in REQ-075 feat commit.
      void requireRoomMember;
      return reply.status(501).send({ error: "not_implemented" });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/:id",
    async (
      _request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      return reply.status(501).send({ error: "not_implemented" });
    },
  );
}
