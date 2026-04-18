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
  },
  // §5 + ADR-0004: username is validated at the sign-up boundary and
  // written atomically with the user row. The zod `registerSchema` in
  // packages/shared/src/dto.ts also guards shape at the Fastify layer
  // (task #2b), but this config is what makes NOT NULL safe in the DB.
  user: {
    additionalFields: {
      username: { type: "string", required: true, input: true },
    },
    // Task #11 (v3.docx §2.1.5 "Account Removal"). `deleteUser.enabled: true`
    // exposes better-auth's built-in `POST /api/auth/delete-user` (verified
    // POST in update-user.mjs:215 — Context7 docs say DELETE; docs are wrong),
    // which accepts `{ password }` in the body for re-auth. FK-level
    // `onDelete: "cascade"` on `session.userId` and `account.userId`
    // (schema.ts) does the auth-surface cleanup; `beforeDelete` is the hook
    // where v3 §2.1.5's room-level cascade WILL live in S2 (currently a
    // no-op — rooms don't exist yet). See §10 "before task #11" and
    // "task #11 — method" for rationale. NOTE: commit 38679e1's subject line
    // says "task #7" — that was written before the collision was spotted and
    // is an immutable git-history artifact; current §6 + §10 numbering treats
    // account deletion as task #11.
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
