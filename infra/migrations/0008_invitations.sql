-- 0008_invitations.sql — wave1 agent B (feat/invitations)
-- Evolves the 0000-scaffolded room_invite table + room_invite_status enum
-- to the shape REQ-089 / REQ-089a need (see docs/specs/s2-invitations.md §5).
--   - rename 'rejected' → 'declined' (matches protocol event + user-facing verb)
--   - add 'expired' (for future GC sweep; we never INSERT it in wave1)
--   - add responded_at (nullable) + expires_at (NOT NULL default now()+14d per REQ-089a)
--   - swap the full unique(room_id,invitee_id) for a partial unique on status='pending'
--     so (roomId,inviteeId) can host multiple historical rows but at most one live invite.
--   - add (invitee_id, status) index for the inbox query.
ALTER TYPE "public"."room_invite_status" RENAME VALUE 'rejected' TO 'declined';--> statement-breakpoint
ALTER TYPE "public"."room_invite_status" ADD VALUE 'expired';--> statement-breakpoint
ALTER TABLE "room_invite" ADD COLUMN "responded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_invite" ADD COLUMN "expires_at" timestamp with time zone NOT NULL DEFAULT (now() + interval '14 days');--> statement-breakpoint
DROP INDEX IF EXISTS "room_invite_room_invitee_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "room_invite_room_invitee_pending_uq" ON "room_invite" ("room_id", "invitee_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "room_invite_invitee_status_idx" ON "room_invite" ("invitee_id", "status");
