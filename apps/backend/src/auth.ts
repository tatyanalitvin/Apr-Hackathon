// better-auth configuration.
// Imports verified via Context7 (2026-04-18):
//   import { betterAuth } from "better-auth"
//   import { drizzleAdapter } from "better-auth/adapters/drizzle"
// Provider "pg" maps to the postgres tables in packages/shared/schema.

import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { room, roomMember } from "@ai-herders/shared/schema";
import { db } from "./db";
import { env } from "./env";
import { logger } from "./lib/logger";
import { secondaryStorage } from "./secondary-storage";

const GENERAL_ROOM_ID = "general";

// better-auth namespaces its session cookie with the library prefix; verified
// at runtime + sourced from node_modules/better-auth/dist/cookies.mjs. Surfaced
// as a constant so the CSRF cookie-stamping path in app.ts can match against
// it without re-encoding the prefix inline — bumping better-auth across a
// major rename will fail typecheck/grep here instead of silently breaking
// sign-up/sign-in CSRF issuance.
export const SESSION_COOKIE_PREFIX = "better-auth.session_token=";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    // Task #7 (v3.docx §2.1.4, REQ-019) — password-reset-request stub.
    // better-auth's `/request-password-reset` endpoint (path verified in
    // node_modules/better-auth/dist/api/routes/password.mjs:20; Context7
    // calls it `forget-password`, which is only the email-otp plugin's
    // path) returns `RESET_PASSWORD_DISABLED` 4xx unless this callback
    // is configured. For S1 we log `{email, token}` via pino with a
    // TODO(S3) marker so a dev can copy the token from server output;
    // S3 swaps this for real SMTP (nodemailer/SES) per FOLLOWUPS.md.
    // In production the token is truncated to its first 6 chars so a
    // leaked log line alone can't complete a reset — the full token
    // still lives in the `verification` table for genuine incident-
    // response. Non-existent emails never reach here: better-auth
    // short-circuits with an anti-enumeration 200 + timing-parity dummy
    // lookup in password.mjs:51-62.
    sendResetPassword: async ({ user, token }) => {
      const redacted = env.NODE_ENV === "production" ? token.slice(0, 6) : token;
      logger.info(
        { email: user.email, token: redacted, todo: "S3:wire-nodemailer" },
        "password reset requested (stub — no email sent)",
      );
    },
    // REQ-017/REQ-018 — drop all active sessions when the password is reset
    // via token. Matches the S2 forgot-password UI brief's contract: a
    // successful /api/auth/reset-password call logs the user out of every
    // device they previously signed in on. Handled by better-auth's
    // `deleteSessions(userId)` call in api/routes/password.mjs:164 when this
    // flag is true.
    revokeSessionsOnPasswordReset: true,
  },
  // §5 + ADR-0004: username is validated at the sign-up boundary and
  // written atomically with the user row. The zod `registerSchema` in
  // packages/shared/src/dto.ts also guards shape at the Fastify layer
  // (task #2b), but this config is what makes NOT NULL safe in the DB.
  user: {
    additionalFields: {
      username: { type: "string", required: true, input: true },
    },
    // S2 supersedes the S1 task #11 hard-delete path. better-auth's built-in
    // `POST /api/auth/delete-user` would purge the user row, which conflicts
    // with v3.docx §2.2 ("messages remain visible after account removal") and
    // would break `message.authorId` FKs. The S2 contract lives at
    // `DELETE /api/v1/users/me` (apps/backend/src/routes/account.ts): soft-
    // delete user + hard-delete relationship edges + preserve messages with
    // "[deleted user]" substitution at serialization. Leaving
    // `deleteUser.enabled` unset keeps the old path returning 404, so there's
    // exactly one deletion surface. s1-auth.md §4 R18's REQ-125 claim is now
    // covered by `tests/account-delete.test.ts`'s happy-path case (sessions
    // revoked, cookie stops auth'ing).
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
  //
  // REQ-014 — session lifetime. Spec target is ≥ 7 days so users who ticked
  // "keep me signed in" aren't kicked back to /login daily. better-auth 1.6.x
  // already defaults to 7 days, but we pin it explicitly here so a silent
  // upstream default change can't shorten sessions without a visible diff.
  // updateAge=1d slides the expiry when an active session is used, which is
  // the usual "refresh on activity" UX.
  session: {
    storeSessionInDatabase: true,
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
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
      // REQ-009 — 5 registrations per IP per hour. The /24 subnet rule in v4
      // is deferred to FOLLOWUPS #6 (requires custom keyGenerator + CIDR).
      "/sign-up/email": { window: 3600, max: 5 },
    },
  },
  // Auto-enroll every newly created user into the seeded 'general' room so a
  // fresh signup can immediately post to /api/v1/rooms/general/messages without
  // a separate join step. NOT a v4 REQ — v4 REQ-022 is "Room description"
  // (unimplemented; tracked in FOLLOWUPS.md #10).
  //
  // This is a permanent non-v4 UX convenience; claimed in s2-rooms.md §7
  // (non-v4 deviations) and ADR-0006. Covered by register-auto-enroll.test.ts.
  // It is NOT superseded by v4 REQ-025 (room catalog) / REQ-026 (self-join) —
  // those enable users to discover and join OTHER rooms; this hook solves the
  // signup-to-first-message dead-end that would otherwise force every new user
  // through a manual #general join.
  //
  // Hook API verified in
  // node_modules/.pnpm/@better-auth+core@1.6.5/.../types/init-options.d.mts
  // lines 1059-1077 (`databaseHooks.user.create.after`). The hook fires AFTER
  // the user row is written, regardless of sign-up surface (HTTP or internal
  // `auth.api.signUpEmail` from scripts/seed.ts). Silent-skip when the room
  // is not seeded (e.g. dev DB without `pnpm db:seed`) — a throw here would
  // fail the whole sign-up, which is much worse than a user who has to join
  // a room manually.
  databaseHooks: {
    user: {
      create: {
        // REQ-003 / REQ-005 — case-insensitive uniqueness. better-auth 1.6.5
        // lowercases `email` on sign-up and lookup (sign-up.mjs:163,
        // internal-adapter.mjs:448/488), but `username` is an additionalField
        // and is NOT normalized. Normalize both here so the DB's
        // `LOWER(email)` / `LOWER(username)` unique indexes see a consistent
        // canonical form regardless of sign-up surface. Hook signature is
        // `before(user) => { data }` (verified in
        // node_modules/@better-auth/core/.../types/init-options.d.mts).
        before: async (newUser) => {
          const u = newUser as typeof newUser & { username?: string };
          return {
            data: {
              ...u,
              email: u.email.toLowerCase(),
              ...(typeof u.username === "string"
                ? { username: u.username.toLowerCase() }
                : {}),
            },
          };
        },
        after: async (newUser) => {
          try {
            const [general] = await db
              .select({ id: room.id })
              .from(room)
              .where(eq(room.id, GENERAL_ROOM_ID))
              .limit(1);
            if (!general) {
              logger.warn(
                { userId: newUser.id },
                "auto-enroll skipped: 'general' room not seeded",
              );
              return;
            }
            await db
              .insert(roomMember)
              .values({
                id: randomUUID(),
                userId: newUser.id,
                roomId: general.id,
              })
              .onConflictDoNothing({
                target: [roomMember.userId, roomMember.roomId],
              });
          } catch (err) {
            logger.warn(
              { err, userId: newUser.id },
              "auto-enroll into 'general' failed (non-fatal)",
            );
          }
        },
      },
    },
  },
  secret: env.SESSION_SECRET,
  baseURL: env.WEB_ORIGIN,
  trustedOrigins: [env.WEB_ORIGIN],
});

export type Auth = typeof auth;
