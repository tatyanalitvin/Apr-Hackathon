// better-auth configuration.
// Imports verified via Context7 (2026-04-18):
//   import { betterAuth } from "better-auth"
//   import { drizzleAdapter } from "better-auth/adapters/drizzle"
// Provider "pg" maps to the postgres tables in packages/shared/schema.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db";
import { env } from "./env";
import { secondaryStorage } from "./secondary-storage";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  // §5 + ADR-0004: username is validated at the sign-up boundary and
  // written atomically with the user row. The zod `registerSchema` in
  // packages/shared/src/dto.ts also guards shape at the Fastify layer
  // (task #2b), but this config is what makes NOT NULL safe in the DB.
  user: {
    additionalFields: {
      username: { type: "string", required: true, input: true },
    },
  },
  // Redis-backed KV for rate-limit counters (and any future session-cache
  // opt-in). See src/secondary-storage.ts and s1-auth.md §10 decision log —
  // using Redis here pulls the S3 "distributed rate-limit storage" forward
  // from FOLLOWUPS.md in ~5 lines and makes the test harness's
  // beforeEach flushRedis() automatically reset counters between tests.
  secondaryStorage,
  // Default when secondaryStorage is set is to store sessions ONLY in Redis
  // and skip the DB. Our REQ-018 DELETE /api/v1/sessions/:id ownership guard
  // (task #6b) does a DB lookup by session.id to verify `row.userId ===
  // caller.user.id`; that lookup needs the row to exist in Postgres. Forcing
  // storeSessionInDatabase=true keeps Postgres as the source of truth for
  // sessions — Redis is only used for rate-limit counters.
  session: {
    storeSessionInDatabase: true,
  },
  // Task #10 — rate-limit pinning (REQ-014). `customRules["/sign-in/email"]`
  // caps wrong-creds at 5 within a 60s window so the REQ-014 "≤10 attempts"
  // budget is enforced with headroom. Global defaults stay generous (100/60s)
  // so well-behaved clients (and the other login tests) are unaffected.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: "secondary-storage",
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
    },
  },
  secret: env.SESSION_SECRET,
  baseURL: env.WEB_ORIGIN,
  trustedOrigins: [env.WEB_ORIGIN],
});

export type Auth = typeof auth;
