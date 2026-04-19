// R9 (REQ-062) seq parity — a DM room's message_seq allocator behaves
// identically to a group room's. 100 parallel sends on one DM →
// 100 unique contiguous seqs, each with roomHeadSeq === message.seq.
//
// The allocator is roomId-addressed and has no awareness of kind, so
// this is strictly a parity test: if S1's 100-parallel test passes,
// this should too. Ships anyway because REQ-062 explicitly calls out
// seq correctness on DMs, and a regression where the DM route bypasses
// the allocator would otherwise go unnoticed.

import { beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

import { allocateAndInsertMessage } from "../src/lib/seq-allocator";
import { getTestDb } from "./db-helpers";

const DM_ROOM_ID = "r-dm-seq-1";
const ALICE_ID = "u-dm-alice-seq";
const BOB_ID = "u-dm-bob-seq";

async function seedDm(): Promise<void> {
  const db = getTestDb();
  await db.insert(user).values([
    {
      id: ALICE_ID,
      name: "DM Seq Alice",
      email: "dm-seq-alice@example.com",
      username: "dm_seq_alice",
    },
    {
      id: BOB_ID,
      name: "DM Seq Bob",
      email: "dm-seq-bob@example.com",
      username: "dm_seq_bob",
    },
  ]);
  const [low, high] = ALICE_ID < BOB_ID ? [ALICE_ID, BOB_ID] : [BOB_ID, ALICE_ID];
  await db.insert(room).values({
    id: DM_ROOM_ID,
    name: null,
    kind: "dm",
    visibility: "private",
    ownerId: null,
    dmPairKey: `${low}:${high}`,
  });
  await db.insert(roomMember).values([
    { id: "rm-dm-seq-a", userId: ALICE_ID, roomId: DM_ROOM_ID, role: "member" },
    { id: "rm-dm-seq-b", userId: BOB_ID, roomId: DM_ROOM_ID, role: "member" },
  ]);
  await db.insert(messageSeq).values({ roomId: DM_ROOM_ID, seq: 0n });
}

describe("REQ-062 R9 DM seq parity with group rooms", () => {
  beforeEach(async () => {
    await seedDm();
  });

  test("REQ-062 R9 100 parallel DM sends yield 100 unique contiguous seqs", async () => {
    const N = 100;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        allocateAndInsertMessage({
          messageId: randomUUID(),
          roomId: DM_ROOM_ID,
          authorId: ALICE_ID,
          authorUsername: "dm_seq_alice",
          authorName: "DM Seq Alice",
          body: `dm-parallel-${i}`,
        }),
      ),
    );

    const seqs = results.map((r) => r.message.seq);
    expect(seqs).toHaveLength(N);
    expect(new Set(seqs).size).toBe(N);
    const min = seqs.reduce((a, b) => (a < b ? a : b));
    const max = seqs.reduce((a, b) => (a > b ? a : b));
    expect(min).toBe(1n);
    expect(max).toBe(BigInt(N));
    expect(max - min).toBe(BigInt(N - 1));

    // DB agrees: N message rows with unique seqs + counter == N.
    const rows = await getTestDb()
      .select({ seq: message.seq })
      .from(message)
      .where(eq(message.roomId, DM_ROOM_ID));
    expect(rows).toHaveLength(N);
    expect(new Set(rows.map((r) => r.seq)).size).toBe(N);

    const [seqRow] = await getTestDb()
      .select({ seq: messageSeq.seq })
      .from(messageSeq)
      .where(eq(messageSeq.roomId, DM_ROOM_ID));
    expect(seqRow!.seq).toBe(BigInt(N));
  });
});
