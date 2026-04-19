-- 0007_room_roles.sql — room moderation backfill (feat/room-roles, agent A).
-- Binding spec: docs/specs/s2-moderation.md §4 REQ-200.
--
-- DDL lives in 0000_chilly_whirlwind.sql:
--   - room_role enum ('owner'|'admin'|'member')                    (line 4)
--   - room_member.role column DEFAULT 'member' NOT NULL             (line 103)
--   - room_ban table {id, room_id, user_id, banned_by_id, reason}   (line 81)
-- This migration only backfills legacy owner-membership rows whose `role`
-- column is still the default 'member' because they predate c84948c's
-- create-room handler setting role='owner' at INSERT time.
--
-- Idempotent: re-running against a DB where owner rows are already 'owner'
-- matches zero rows (UPDATE's rowCount = 0). Assertions enforced by
-- tests/room-moderation-migration.test.ts REQ-200.

UPDATE room_member
   SET role = 'owner'
 WHERE (room_id, user_id) IN (
         SELECT id, owner_id FROM room WHERE owner_id IS NOT NULL
       )
   AND role <> 'owner';
