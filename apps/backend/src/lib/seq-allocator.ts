// Atomic per-room seq allocator (ADR-0003 watermark protocol, REQ-030/032/037)
// with REQ-033 clientMessageId idempotency.
//
// Strategy (happy path, no clientMessageId):
//   UPDATE message_seq SET seq = seq + 1 WHERE room_id = $1 RETURNING seq,
//   immediately followed by INSERT INTO message — both inside one transaction.
//
// Under concurrency Postgres takes an implicit ROW EXCLUSIVE lock on the
// message_seq row during the UPDATE. Concurrent transactions touching the same
// roomId queue on that lock and run serially; each gets its own seq. This is
// the simpler of the two variants in spec §5 "Seq allocation". The
// (roomId, seq) unique index on message is a belt-and-braces check.
//
// Idempotency (REQ-033, clientMessageId present):
//   1. Fast-path SELECT for (roomId, clientMessageId) inside the txn — if it
//      exists we return immediately, no seq is burnt.
//   2. Otherwise advance seq and INSERT ... ON CONFLICT DO NOTHING against the
//      partial unique index (roomId, clientMessageId). If another transaction
//      committed the same key between step 1 and step 2, the INSERT returns no
//      row and we SELECT the winner. That wasted seq is acceptable — retries
//      are rare, seq is bigint, and monotonicity is preserved.
//
// On dedup (existing row returned) the caller should NOT re-broadcast
// message.new — `deduped: true` is the signal.

import { and, eq, sql } from "drizzle-orm";
import { message, messageSeq, type Message } from "@ai-herders/shared/schema";
import { db } from "../db";

export interface AllocateMessageInput {
  messageId: string;
  roomId: string;
  authorId: string;
  body: string;
  replyToId?: string | null;
  clientMessageId?: string | null;
}

export interface AllocatedMessage {
  message: Message;
  roomHeadSeq: bigint;
  deduped: boolean;
}

export async function allocateAndInsertMessage(
  input: AllocateMessageInput,
): Promise<AllocatedMessage> {
  return db.transaction(async (tx) => {
    const cid = input.clientMessageId ?? null;

    // Fast path — a prior submit with the same key already won. Saves a seq.
    if (cid) {
      const [existing] = await tx
        .select()
        .from(message)
        .where(
          and(
            eq(message.roomId, input.roomId),
            eq(message.clientMessageId, cid),
          ),
        )
        .limit(1);
      if (existing) {
        const [seqRow] = await tx
          .select({ seq: messageSeq.seq })
          .from(messageSeq)
          .where(eq(messageSeq.roomId, input.roomId));
        return {
          message: existing,
          roomHeadSeq: seqRow?.seq ?? existing.seq,
          deduped: true,
        };
      }
    }

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

    const values = {
      id: input.messageId,
      roomId: input.roomId,
      authorId: input.authorId,
      seq: newSeq,
      body: input.body,
      clientMessageId: cid,
      replyToId: input.replyToId ?? null,
    };

    if (cid) {
      const inserted = await tx
        .insert(message)
        .values(values)
        .onConflictDoNothing({
          target: [message.roomId, message.clientMessageId],
          // Partial unique index predicate — matches the migration's
          // `WHERE client_message_id IS NOT NULL`. Without this Postgres
          // cannot find the matching constraint.
          where: sql`${message.clientMessageId} IS NOT NULL`,
        })
        .returning();
      const row = inserted[0];
      if (row) return { message: row, roomHeadSeq: newSeq, deduped: false };

      // Race lost — another committer wrote the same (roomId, cid) between our
      // SELECT and INSERT. Return their row.
      const [winner] = await tx
        .select()
        .from(message)
        .where(
          and(
            eq(message.roomId, input.roomId),
            eq(message.clientMessageId, cid),
          ),
        )
        .limit(1);
      if (!winner) {
        throw new Error(
          "ON CONFLICT DO NOTHING returned no row yet the conflicting row is missing",
        );
      }
      return { message: winner, roomHeadSeq: newSeq, deduped: true };
    }

    const [inserted] = await tx.insert(message).values(values).returning();
    if (!inserted) {
      throw new Error("INSERT INTO message returned no row");
    }
    return { message: inserted, roomHeadSeq: newSeq, deduped: false };
  });
}
