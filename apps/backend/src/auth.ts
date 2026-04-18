// better-auth configuration.
// Imports verified via Context7 (2026-04-18):
//   import { betterAuth } from "better-auth"
//   import { drizzleAdapter } from "better-auth/adapters/drizzle"
// Provider "pg" maps to the postgres tables in packages/shared/schema.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db";
import { env } from "./env";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  secret: env.SESSION_SECRET,
  baseURL: env.WEB_ORIGIN,
  trustedOrigins: [env.WEB_ORIGIN],
  // Wire better-auth endpoints in S1 via Fastify handler bridge.
});

export type Auth = typeof auth;
