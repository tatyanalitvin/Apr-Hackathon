-- REQ-003 / REQ-005 — case-insensitive uniqueness for user.email + user.username.
-- Drops the plain UNIQUE constraints emitted by drizzle-kit (0000_*) and
-- replaces them with expression indexes on LOWER(...), so 'Alice@x.com' and
-- 'alice@x.com' collide (same for 'Alice'/'alice' on username).
--
-- better-auth 1.6.5 already lowercases email at sign-up/sign-in; the index
-- is defense-in-depth against direct INSERT. username is an additionalField
-- and is NOT lowercased by better-auth — it is normalized by the
-- `databaseHooks.user.create.before` hook in apps/backend/src/auth.ts.
--
-- Hand-authored (expression/partial indexes don't round-trip through
-- drizzle-kit cleanly; 0003/0004/0006+ follow the same hand-authored pattern
-- and meta snapshots only track up to 0005). See docs/FOLLOWUPS.md.

ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_email_unique";
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_username_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "user_email_ci_uq" ON "user" (LOWER("email"));
CREATE UNIQUE INDEX IF NOT EXISTS "user_username_ci_uq" ON "user" (LOWER("username"));
