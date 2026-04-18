// Standalone pino logger for non-Fastify call sites.
//
// Fastify's own logger (wired in app.ts via `{ logger: { level: env.LOG_LEVEL } }`)
// is only in scope where `request.log` / `app.log` is available. better-auth
// callbacks like `emailAndPassword.sendResetPassword` run outside that scope —
// they receive `({user, url, token}, request)` where `request` is the raw
// Fetch Request, not Fastify's. This module gives those callers a pino
// instance configured with the same LOG_LEVEL so log-level behaviour stays
// consistent between the HTTP path and these side-channels.

import pino from "pino";
import { env } from "../env";

export const logger = pino({ level: env.LOG_LEVEL });
