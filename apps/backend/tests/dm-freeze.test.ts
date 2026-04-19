// R5 (REQ-066) freeze predicate — unit tests for lib/dm-freeze.ts.
//
// CONTRACT (locked; attachments agent's R13 un-skip depends on this):
//   isDmFrozen({ roomId, callerId, tx? }): Promise<
//     { frozen: boolean; reason?: 'not_friends' | 'blocked' }
//   >
//
// user_deleted is listing-layer only (spec §5 "freeze predicate —
// placement and cost"); this helper returns `not_friends | blocked`.
//
// Four predicate branches:
//   (a) friends + no block → { frozen: false }
//   (b) not friends        → { frozen: true, reason: 'not_friends' }
//   (c) caller blocks target → { frozen: true, reason: 'blocked' }
//   (d) target blocks caller → { frozen: true, reason: 'blocked' }
//
// The helper resolves the counterpart from room_member (the spec's
// "piggy-backed on requireRoomMember" path is a layering detail — the
// helper is fine running its own 1-row SELECT since it's called outside
// a request context from listing + attachments.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  friendship,
  messageSeq,
  room,
  roomMember,
  user,
  userBlock,
} from "@ai-herders/shared/schema";

import { isDmFrozen } from "../src/lib/dm-freeze";
import { getTestDb } from "./db-helpers";

interface Pair {
  roomId: string;
  callerId: string;
  targetId: string;
}

async function seedDmPair(prefix: string): Promise<Pair> {
  const db = getTestDb();
  const callerId = randomUUID();
  const targetId = randomUUID();
  const [low, high] = callerId < targetId ? [callerId, targetId] : [targetId, callerId];

  await db.insert(user).values([
    {
      id: callerId,
      email: `${prefix}-caller@example.com`,
      username: `${prefix}_caller`,
      name: `${prefix}_caller`,
    },
    {
      id: targetId,
      email: `${prefix}-target@example.com`,
      username: `${prefix}_target`,
      name: `${prefix}_target`,
    },
  ]);

  const roomId = randomUUID();
  await db.insert(room).values({
    id: roomId,
    name: null,
    kind: "dm",
    visibility: "private",
    ownerId: null,
    dmPairKey: `${low}:${high}`,
  });
  await db.insert(roomMember).values([
    { id: randomUUID(), userId: callerId, roomId, role: "member" },
    { id: randomUUID(), userId: targetId, roomId, role: "member" },
  ]);
  await db.insert(messageSeq).values({ roomId });

  return { roomId, callerId, targetId };
}

async function addFriendship(a: string, b: string): Promise<void> {
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await getTestDb()
    .insert(friendship)
    .values({ id: randomUUID(), userAId, userBId });
}

async function addBlock(byId: string, targetId: string): Promise<void> {
  await getTestDb()
    .insert(userBlock)
    .values({ id: randomUUID(), byId, targetId });
}

describe("REQ-066 R5 isDmFrozen predicate", () => {
  // No buildApp — unit test against the raw DB only. Setup/teardown is
  // handled by the test harness in tests/setup.ts (TRUNCATE per test).
  beforeAll(() => {
    // nothing
  });
  afterAll(() => {
    // nothing
  });

  test("REQ-066 R5 friends + no block → not frozen", async () => {
    const { roomId, callerId, targetId } = await seedDmPair("fr-ok");
    await addFriendship(callerId, targetId);

    const result = await isDmFrozen({ roomId, callerId });
    expect(result).toEqual({ frozen: false });
  });

  test("REQ-066 R5 not friends → frozen reason=not_friends", async () => {
    const { roomId, callerId } = await seedDmPair("fr-none");
    // no friendship row.

    const result = await isDmFrozen({ roomId, callerId });
    expect(result).toEqual({ frozen: true, reason: "not_friends" });
  });

  test("REQ-066 R5 caller blocks target → frozen reason=blocked", async () => {
    const { roomId, callerId, targetId } = await seedDmPair("bl-out");
    await addFriendship(callerId, targetId);
    await addBlock(callerId, targetId);

    const result = await isDmFrozen({ roomId, callerId });
    expect(result).toEqual({ frozen: true, reason: "blocked" });
  });

  test("REQ-066 R5 target blocks caller → frozen reason=blocked", async () => {
    const { roomId, callerId, targetId } = await seedDmPair("bl-in");
    await addFriendship(callerId, targetId);
    await addBlock(targetId, callerId);

    const result = await isDmFrozen({ roomId, callerId });
    expect(result).toEqual({ frozen: true, reason: "blocked" });
  });

  test("REQ-066 R5 reason priority — blocked beats not_friends", async () => {
    // Spec §5 priority: user_deleted > blocked > not_friends. The helper
    // doesn't emit user_deleted, but when both blocked AND not_friends
    // are true, blocked MUST win — matches the priority ladder the
    // listing handler relies on.
    const { roomId, callerId, targetId } = await seedDmPair("pri");
    await addBlock(callerId, targetId);
    // no friendship row.

    const result = await isDmFrozen({ roomId, callerId });
    expect(result).toEqual({ frozen: true, reason: "blocked" });
  });

  test("REQ-066 R5 respects transaction handle (tx?)", async () => {
    // The contract accepts an optional tx so call-sites inside the send
    // transaction can pass their handle and read the same snapshot. We
    // don't drive a real rollback here — just exercise the code path so
    // a future regression that drops the tx argument is caught.
    const { roomId, callerId, targetId } = await seedDmPair("tx");
    await addFriendship(callerId, targetId);

    await getTestDb().transaction(async (tx) => {
      const result = await isDmFrozen({ roomId, callerId, tx });
      expect(result).toEqual({ frozen: false });

      const blockedResult = await tx
        .insert(userBlock)
        .values({ id: randomUUID(), byId: targetId, targetId: callerId });
      void blockedResult;

      const second = await isDmFrozen({ roomId, callerId, tx });
      expect(second).toEqual({ frozen: true, reason: "blocked" });
    });
  });

  test("REQ-066 R5 unknown roomId → frozen reason=not_friends (defensive)", async () => {
    // If the caller passes a roomId with no members (shouldn't happen
    // after R3), the helper MUST NOT throw. Treat as frozen.
    const result = await isDmFrozen({
      roomId: randomUUID(),
      callerId: randomUUID(),
    });
    expect(result.frozen).toBe(true);
  });
});
