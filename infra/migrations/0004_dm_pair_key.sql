-- s2-dms R2 / ADR-0007 — canonical DM pair key + partial unique index.
--
-- DMs are `room` rows with kind='dm' (not a separate `dialogs` table; see
-- ADR-0007). The pair key is "userALow:userBHigh" sorted lexicographically by
-- the caller. A partial unique index enforces one-DM-per-pair for kind='dm'
-- rows only; group rooms carry NULL dm_pair_key without colliding.
--
-- Hand-authored: drizzle-kit generate chokes on the 0002→0003 snapshot
-- collision (0003 is the hand-authored friendship CHECK with no schema delta).
-- The migrator at runtime reads _journal.json, not the snapshots, so this
-- migration applies cleanly.

ALTER TABLE "room" ADD COLUMN "dm_pair_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "room_dm_pair_uq"
  ON "room" ("dm_pair_key")
  WHERE "kind" = 'dm';
