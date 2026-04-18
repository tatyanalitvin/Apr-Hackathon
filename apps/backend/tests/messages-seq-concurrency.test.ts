// Task 4 (s1-chat §6) — seq allocator correctness under concurrency.
// Covers REQ-030/REQ-037 (seq advances by 1, strictly increasing) and
// REQ-032 (atomic allocation under 100-way parallel load).
//
// Tests the allocator at the library level so the invariant is pinned BEFORE
// the POST /messages route is wired — a watermark break is the worst possible
// S1 bug and this file is the gate for it.

import { beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  message,
  messageSeq,
  room,
  user,
} from "@ai-herders/shared/schema";

import { allocateAndInsertMessage } from "../src/lib/seq-allocator";
import { getTestDb } from "./db-helpers";

const ROOM_ID = "r-seq-1";
const AUTHOR_ID = "u-seq-1";

async function seedRoomAndAuthor(): Promise<void> {
  const db = getTestDb();
  await db.insert(user).values({
    id: AUTHOR_ID,
    name: "Seq Author",
    email: "seq@example.com",
    username: "seq_author",
  });
  await db.insert(room).values({
    id: ROOM_ID,
    name: "seq-room",
    kind: "group",
    visibility: "public",
    ownerId: AUTHOR_ID,
  });
  await db.insert(messageSeq).values({ roomId: ROOM_ID, seq: 0n });
}

describe("REQ-030/REQ-037 seq advances by 1 and is strictly increasing", () => {
  beforeEach(async () => {
    await seedRoomAndAuthor();
  });

  test("REQ-030/REQ-037 sequential inserts produce seq 1, 2, 3, …", async () => {
    const seqs: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      const { message: row, roomHeadSeq } = await allocateAndInsertMessage({
        messageId: randomUUID(),
        roomId: ROOM_ID,
        authorId: AUTHOR_ID,
        body: `msg-${i}`,
      });
      // roomHeadSeq must equal the new seq after each insert.
      expect(roomHeadSeq).toBe(row.seq);
      seqs.push(row.seq);
    }
    expect(seqs).toEqual([1n, 2n, 3n, 4n, 5n]);

    // The counter row reflects the latest head.
    const [seqRow] = await getTestDb()
      .select({ seq: messageSeq.seq })
      .from(messageSeq)
      .where(eq(messageSeq.roomId, ROOM_ID));
    expect(seqRow.seq).toBe(5n);
  });
});

describe("REQ-032 atomic seq allocation under concurrency", () => {
  beforeEach(async () => {
    await seedRoomAndAuthor();
  });

  test("REQ-032 100 parallel sends yield 100 unique contiguous seqs", async () => {
    const N = 100;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        allocateAndInsertMessage({
          messageId: randomUUID(),
          roomId: ROOM_ID,
          authorId: AUTHOR_ID,
          body: `parallel-${i}`,
        }),
      ),
    );

    const seqs = results.map((r) => r.message.seq);
    expect(seqs).toHaveLength(N);
    expect(new Set(seqs).size).toBe(N);

    const min = seqs.reduce((a, b) => (a < b ? a : b));
    const max = seqs.reduce((a, b) => (a > b ? a : b));
    expect(max - min).toBe(BigInt(N - 1));
    expect(min).toBe(1n);
    expect(max).toBe(BigInt(N));

    // DB agrees: 100 message rows with unique seqs, and counter == N.
    const rows = await getTestDb()
      .select({ seq: message.seq })
      .from(message)
      .where(eq(message.roomId, ROOM_ID));
    expect(rows).toHaveLength(N);
    expect(new Set(rows.map((r) => r.seq)).size).toBe(N);

    const [seqRow] = await getTestDb()
      .select({ seq: messageSeq.seq })
      .from(messageSeq)
      .where(eq(messageSeq.roomId, ROOM_ID));
    expect(seqRow.seq).toBe(BigInt(N));
  });

  test("REQ-032 roomHeadSeq returned equals message.seq for every call", async () => {
    // Each caller sees its own (seq, roomHeadSeq) pair with seq === roomHeadSeq.
    // The event contract (message.new: seq === roomHeadSeq === message.seq on
    // fresh insert) depends on this equality.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        allocateAndInsertMessage({
          messageId: randomUUID(),
          roomId: ROOM_ID,
          authorId: AUTHOR_ID,
          body: "eq-check",
        }),
      ),
    );
    for (const r of results) {
      expect(r.roomHeadSeq).toBe(r.message.seq);
    }
  });
});

describe("seq allocator — fail-fast invariants", () => {
  test("throws when message_seq row missing for the room", async () => {
    // No seedRoomAndAuthor() here; allocator must refuse rather than silently
    // create a row with unclear starting seq.
    const db = getTestDb();
    await db.insert(user).values({
      id: "u-ghost",
      name: "Ghost",
      email: "ghost@example.com",
      username: "u_ghost",
    });
    await db.insert(room).values({
      id: "r-ghost",
      name: "ghost-room",
      kind: "group",
      visibility: "public",
    });

    await expect(
      allocateAndInsertMessage({
        messageId: randomUUID(),
        roomId: "r-ghost",
        authorId: "u-ghost",
        body: "orphan",
      }),
    ).rejects.toThrow(/message_seq/);
  });
});
