import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  // better-auth + CSRF signing. Must be >= 16 chars; 32+ in prod (§2.2).
  SESSION_SECRET: z.string().min(16),
  // §3.4 local-FS storage root for attachments
  UPLOAD_DIR: z.string().default("./infra/uploads"),
  // REQ-158 — CSV of better-auth user IDs allowed to hit /api/v1/admin/*.
  // Default empty: no admins unless explicitly seeded (so tests can't
  // accidentally become admin). See docs/specs on s3-admin and .env.example.
  ADMIN_USER_IDS: z.string().default(""),
  // REQ-089 — cross-agent coordination (docs/specs/s2-invitations.md §5).
  // The invitee-banned 403 branch SELECTs from room_ban, which is owned by
  // agent A's 0007 migration. When `true` (default) the SELECT runs and the
  // 403 path is live; `false` skips the SELECT so a slipped 0007 cannot break
  // invitation send. A startup probe confirms the table actually exists when
  // the flag is on; a missing table downgrades to the same skip semantics as
  // the flag being off, so the backend never boots into a crash loop.
  INVITATIONS_ENFORCE_BAN: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // REQ-147 — global per-IP ceiling applied to every /api/v1/* request by
  // the @fastify/rate-limit plugin (see src/app.ts). Permissive by default
  // so well-behaved clients never trip it; lower this in tests to prove
  // the 429 path without mashing 1000 requests per test.
  APP_RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(1000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail loudly on boot — bad env should not produce a half-working server.
  // eslint-disable-next-line no-console
  console.error("[env] invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
