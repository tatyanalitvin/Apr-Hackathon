# ADR 0007 — DMs are `room` rows with `kind='dm'` (v4 REQ-061/062 deviation)

**Status:** Accepted
**Date:** 2026-04-19
**Scope:** `docs/specs/s2-dms.md` and any future DM-adjacent spec (edit/delete, attachments-on-DM, unread).

## Context

v4 REQ-061 defines a separate `dialogs` table and REQ-062 attaches messages to
one of `room_id` OR `dialog_id` via a CHECK constraint. The schema we shipped
in S1 — `packages/shared/src/schema.ts` — already models DMs differently:

- `room.kind` is a `pgEnum("room_kind", ["group", "dm"])` — DM is a room subkind.
- `room.name` is nullable specifically so DM rooms can derive display names from
  participants.
- `message.roomId` is the only link; there is no `dialog_id` column.
- `messageSeq.roomId` is keyed by room — the same per-room monotonic watermark
  works for DMs with zero additional plumbing.

The S2 DMs task brief is explicit: "reuse existing message + seq + broadcast
pipeline — do not design a separate DM path". This ADR codifies that choice and
documents the resulting v4 deviations so future reviewers see one decision, not
three surprises.

## Decision

**DMs are `room` rows with `kind='dm'`.**

1. **One message pipeline.** Every message — group or DM — goes through
   `POST /api/v1/rooms/:id/messages`, allocates seq via the S1
   `messageSeq` allocator, and broadcasts `message.new` with the same
   `{seq, roomHeadSeq, message}` shape.
2. **No separate message column.** `message.roomId` stays NOT NULL. The v4
   CHECK constraint across `(room_id IS NULL) XOR (dialog_id IS NULL)` is not
   created; there is nothing for it to discriminate.
3. **Freeze is computed, not stored.** `REQ-066` freeze is evaluated at read
   time from `friendship` + `user_block` rows by
   `apps/backend/src/lib/dm-freeze.ts`. No `frozen_at` column on `room` or
   anywhere else.
4. **DM pair canonicalization via `room.dmPairKey`.** A single new nullable
   column on `room`, populated only when `kind='dm'`, plus a partial unique
   index `WHERE kind='dm'`. See s2-dms §5 for rationale.

## Consequences

**Positive**

- Zero-cost socket parity: DM roomIds are just Socket.IO rooms; `room.subscribe`
  already works.
- Zero-cost history parity: `GET /api/v1/rooms/:id/messages` serves DMs and
  group rooms identically.
- Freeze audit is cross-referential — "why is this DM frozen?" is answered by
  looking at `friendship` and `user_block`, not by inspecting a snapshot.

**Negative / tradeoffs**

- No `frozen_at` timestamp. If moderation (S3) wants a "DM frozen at T" audit
  trail, add `room.dmFrozenAt` then. Flagged in s2-dms §7.
- `roomBan` (REQ-090) is a group-room concept; endpoints that mutate bans must
  early-return on `kind='dm'`. Cross-spec contract captured in s2-dms R14.
- Any future "add member" endpoint on `room` must reject `kind='dm'` — DMs are
  strictly pairwise. Cross-spec contract captured in s2-dms R3.
- v4 readers who expected a `dialogs` table will find `room.kind='dm'` instead.
  This ADR is the landing page for that question.

## Alternatives considered

### (a) v4-literal: separate `dialogs` table + `dialog_id` column on `message`

Faithful to v4, but doubles the send-path surface: every handler that reads
`message.roomId` would need a `COALESCE(room_id, dialog_id)` or a branch on
`kind`. Socket.IO room naming also forks — DM broadcasts would target
`dialog:<id>`, forcing the client to maintain two subscription kinds. The seq
allocator would need a second counter table. Estimated ~300 LOC of net addition
for a table of 2-row rooms that could have used `room` as-is.

### (b) Separate `dm` table, reuse `message` via a view

Middle ground: a small `dm(roomId, userALow, userBHigh)` table mirroring the
pair shape, but `message` and `messageSeq` unchanged. This is effectively (a)
without the message split, but it still forks room-lookup code: `GET /dms` and
`GET /rooms/:id/messages` would need to join `dm` to resolve counterparts. The
partial unique index on `room.dmPairKey` delivers the same O(1) find at
1/10th the code.

### (c) Chosen: `room.kind='dm'` + `dmPairKey` column

Single table, single index, single pipeline. Trades the (theoretical) purity of
a dedicated DM entity for the (actual) ergonomics of one message model across
the whole app.

## References

- `docs/specs/s2-dms.md` — binding spec (R1..R14)
- `docs/specs/s2-dms.md` §5 — schema delta rationale
- `docs/adr/0003-watermark-protocol.md` — seq + broadcast contract this reuses
- `docs/adr/0006-req-catalog-canonical.md` — v4 REQ-060..066 mapping
