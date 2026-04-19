// REQ-066 R5 — DM freeze predicate.
//
// Computes at read time whether a DM room is currently frozen for the
// caller, based on live `friendship` + `user_block` rows. No stored
// `frozen_at` column (ADR-0007) — the predicate IS the state.
//
// CONTRACT (public — attachments R13 + future edit/delete specs depend
// on the exact signature):
//   isDmFrozen({ roomId, callerId, tx? }): Promise<
//     { frozen: boolean; reason?: 'not_friends' | 'blocked' }
//   >
//
// `user_deleted` is NOT a reason the helper emits — that branch lives
// in the listing handler (R11) because this helper has no session
// context and is called from paths where the counterpart's user row
// hasn't been loaded. If Q6 flips to option (b), extend the return
// type here and move the branch in — one call-site change in R11.
//
// Reason priority (spec §5): user_deleted > blocked > not_friends. The
// helper enforces blocked > not_friends; user_deleted is layered on
// top at the listing layer.

import { and, eq, or } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { friendship, roomMember, userBlock } from "@ai-herders/shared/schema";

import { db } from "../db";

// Drizzle's tx types are generic over the dialect; accept the broadest
// shape so callers can pass `tx` from any transaction() callback
// without fighting the type parameters. The methods we use (.select)
// exist on all dialects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = typeof db | PgTransaction<any, any, any>;

export type DmFrozenReason = "not_friends" | "blocked";

export interface DmFrozenResult {
  frozen: boolean;
  reason?: DmFrozenReason;
}

export interface IsDmFrozenInput {
  roomId: string;
  callerId: string;
  tx?: Executor;
}

export async function isDmFrozen({
  roomId,
  callerId,
  tx,
}: IsDmFrozenInput): Promise<DmFrozenResult> {
  const exec: Executor = tx ?? db;

  // Resolve the counterpart user. A DM has exactly 2 members (R3); the
  // counterpart is the one that isn't the caller. If the room has no
  // other member (shouldn't happen after R3, but defensive anyway),
  // treat as frozen — there's no one to message.
  const members = await exec
    .select({ userId: roomMember.userId })
    .from(roomMember)
    .where(eq(roomMember.roomId, roomId));
  const counterpart = members.find((m) => m.userId !== callerId);
  if (!counterpart) {
    return { frozen: true, reason: "not_friends" };
  }
  const targetId = counterpart.userId;

  // Reason priority — blocked beats not_friends. Check blocks first so
  // a "not friends AND blocked" state reports `blocked`, matching the
  // spec §5 reason ladder and the R11 listing logic.
  const [blockRow] = await exec
    .select({ id: userBlock.id })
    .from(userBlock)
    .where(
      or(
        and(eq(userBlock.byId, callerId), eq(userBlock.targetId, targetId)),
        and(eq(userBlock.byId, targetId), eq(userBlock.targetId, callerId)),
      ),
    )
    .limit(1);
  if (blockRow) {
    return { frozen: true, reason: "blocked" };
  }

  const [userAId, userBId] =
    callerId < targetId ? [callerId, targetId] : [targetId, callerId];
  const [friendRow] = await exec
    .select({ id: friendship.id })
    .from(friendship)
    .where(
      and(eq(friendship.userAId, userAId), eq(friendship.userBId, userBId)),
    )
    .limit(1);
  if (!friendRow) {
    return { frozen: true, reason: "not_friends" };
  }

  return { frozen: false };
}
