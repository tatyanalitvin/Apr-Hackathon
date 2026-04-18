// Atomic per-room seq allocator (ADR-0003 watermark protocol, REQ-030/032/037).
//
// Strategy: UPDATE message_seq SET seq = seq + 1 WHERE room_id = $1 RETURNING seq,
// immediately followed by INSERT INTO message — both inside one transaction.
//
// Why this works under concurrency: Postgres takes an implicit ROW EXCLUSIVE
// lock on the message_seq row during the UPDATE. Concurrent transactions touching
// the same roomId queue on that lock and run serially; each gets its own seq.
// This is the simpler variant of the two listed in spec §5 "Seq allocation"
// (SELECT … FOR UPDATE is the moral equivalent but more verbose in drizzle).
// If this ever fails a concurrency test we can swap in pg_advisory_xact_lock
// per spec §5, but empirically this is enough.
//
// The `(roomId, seq)` unique index on message is a belt-and-braces check: if
// two callers ever did end up with the same seq (they shouldn't), the second
// INSERT would raise a unique-violation rather than silently corrupting the
// watermark stream.

import { eq, sql } from "drizzle-orm";
import { message, messageSeq, type Message } from "@ai-herders/shared/schema";
import { db } from "../db";

export interface AllocateMessageInput {
  messageId: string;
  roomId: string;
  authorId: string;
  body: string;
  replyToId?: string | null;
}

export interface AllocatedMessage {
  message: Message;
  roomHeadSeq: bigint;
}

export async function allocateAndInsertMessage(
  input: AllocateMessageInput,
): Promise<AllocatedMessage> {
  return db.transaction(async (tx) => {
    const seqRows = await tx
      .update(messageSeq)
      .set({ seq: sql`${messageSeq.seq} + 1` })
      .where(eq(messageSeq.roomId, input.roomId))
      .returning({ seq: messageSeq.seq });

    const seqRow = seqRows[0];
    if (!seqRow) {
      throw new Error(
        `message_seq row missing for room ${input.roomId} — seed/room-create must insert it before first message`,
      );
    }
    const newSeq = seqRow.seq;

    const [inserted] = await tx
      .insert(message)
      .values({
        id: input.messageId,
        roomId: input.roomId,
        authorId: input.authorId,
        seq: newSeq,
        body: input.body,
        replyToId: input.replyToId ?? null,
      })
      .returning();

    if (!inserted) {
      // Postgres INSERT ... RETURNING always returns the inserted row; this
      // branch exists only to narrow the type.
      throw new Error("INSERT INTO message returned no row");
    }

    return { message: inserted, roomHeadSeq: newSeq };
  });
}
