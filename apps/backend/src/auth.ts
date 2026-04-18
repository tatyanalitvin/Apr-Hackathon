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
    // Task #7 (v3.docx §2.1.5 "Account Removal"). `deleteUser.enabled: true`
    // exposes better-auth's built-in `POST /api/auth/delete-user` (verified
    // POST in update-user.mjs:215 — Context7 docs say DELETE; docs are wrong),
    // which accepts `{ password }` in the body for re-auth. FK-level
    // `onDelete: "cascade"` on `session.userId` and `account.userId`
    // (schema.ts) does the auth-surface cleanup; `beforeDelete` is the hook
    // where v3 §2.1.5's room-level cascade WILL live in S2 (currently a
    // no-op — rooms don't exist yet). See §10 "before task #7" and
    // "task #7 — method" for rationale.
    deleteUser: {
      enabled: true,
      beforeDelete: async (_u: unknown) => {
        // TODO(S2-rooms): enumerate rooms owned by the user, delete them
        // and their messages+attachments. v3.docx §2.1.5 mandates this;
        // schema's `room.ownerId` is `onDelete: "set null"` today, which
        // would leave orphaned rooms behind — flip to cascade OR do it
        // here. Deferred until rooms ship.
      },
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
