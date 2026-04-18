-- Denormalise author identity onto message rows (snapshot at send-time).
-- See protocol.ts MessagePayload + schema.ts message table.
--
-- Strategy: add nullable → backfill from user JOIN → enforce NOT NULL.
-- Plain NOT NULL ADD COLUMN would reject any existing rows.
ALTER TABLE "message" ADD COLUMN "author_username" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "author_name" text;--> statement-breakpoint
UPDATE "message" m
  SET "author_username" = u."username",
      "author_name" = u."name"
  FROM "user" u
  WHERE m."author_id" = u."id";--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "author_username" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "author_name" SET NOT NULL;
