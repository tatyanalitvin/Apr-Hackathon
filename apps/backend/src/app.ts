import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";
import Redis from "ioredis";
import type { ZodType } from "zod";
import { eq } from "drizzle-orm";
import { user } from "@ai-herders/shared/schema";
import { registerSchema, loginSchema } from "@ai-herders/shared/dto";
import { env } from "./env";
import { auth } from "./auth";
import { db } from "./db";
import { toFetchHeaders } from "./lib/fetch-headers";
import { sessionsRoutes } from "./routes/sessions";
import { messagesRoutes } from "./routes/messages";
import { friendshipRoutes } from "./routes/friendship";
import { roomsRoutes } from "./routes/rooms";
import { invitationsRoutes } from "./routes/invitations";
import { attachmentsRoutes } from "./routes/attachments";
import { dmsRoutes } from "./routes/dms";
import { adminRoutes } from "./routes/admin";
import { accountRoutes } from "./routes/account";
import { readReceiptsRoutes } from "./routes/read-receipts";
import { mutesRoutes } from "./routes/mutes";
import { recordHttpError, shouldCountHttpError } from "./lib/metrics";
import {
  csrfPreHandler,
  generateCsrfToken,
  issueCsrfCookie,
} from "./lib/csrf";
import { createSocketIO, type ChatIOServer } from "./socket";
import { installSocketAuth } from "./socket-auth";
import { registerSocketHandlers } from "./socket-handlers";
import { attachPresenceIO } from "./lib/presence";

declare module "fastify" {
  interface FastifyInstance {
    io: ChatIOServer;
  }
}

export interface BuildAppOptions {
  // REQ-147 — per-build override for the global @fastify/rate-limit cap.
  // Tests need to pin a deterministic, low cap WITHOUT racing the env.ts
  // module-load that happens when the first import of src/env runs (vitest
  // singleFork caches modules across test files — whichever test file
  // imported src/app first pins env.APP_RATE_LIMIT_GLOBAL_MAX for the
  // whole fork). Passing it via options side-steps that.
  rateLimitGlobalMax?: number;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    trustProxy: true,
  });

  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
  });

  // S2 attachments. Outer fileSize = 20 MB hard cap (REQ-077 file ceiling); the
  // 3 MB image cap is enforced in the handler post-write (R8) because the
  // plugin can't conditionalise on mimetype. files=1 is the single-file rule
  // (REQ-079 + R2). fields/fieldSize bound the metadata side: file +
  // roomId + comment (≤500 chars) + a margin for the future S3 csrf token.
  await app.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 1,
      fields: 4,
      fieldSize: 600,
    },
    throwFileSizeLimit: false,
  });

  // REQ-147 — @fastify/rate-limit with Redis store (ioredis, separate
  // connection from better-auth's node-redis secondary-storage — the two
  // clients can't share because the plugin uses `defineCommand` for a Lua
  // script not present in node-redis). Global per-IP ceiling applied to
  // every route; per-route overrides land via `config.rateLimit` in the
  // route files (see routes/messages.ts, rooms.ts, etc.).
  //
  // - `skipOnError: true` means a Redis outage does NOT fail every request;
  //   the limiter silently passes through. Avoids cascading a Redis
  //   degradation into a site-wide 503. The counter coverage gap is
  //   noisy (log line per request) but non-fatal.
  // - `errorResponseBuilder` overrides the plugin's default
  //   `{statusCode,error,message}` shape with `{error:"rate_limited",
  //   retryAfter}` — chat-api.ts roomMutation's 429 branch already reads
  //   this shape.
  // - `/health` is in `allowList` so docker probes don't consume the
  //   bucket. `/socket.io/*` is skipped via `skipOnRoute` because Engine
  //   .IO sends a ping every ~25s per client, which would fill the per-IP
  //   bucket fast in a 300-user load test.
  const rateLimitRedis = new Redis(env.REDIS_URL);
  rateLimitRedis.on("error", (err) => {
    app.log.warn({ err }, "rate-limit redis error");
  });
  app.addHook("onClose", async () => {
    await rateLimitRedis.quit().catch(() => undefined);
  });
  await app.register(fastifyRateLimit, {
    global: true,
    max: options.rateLimitGlobalMax ?? env.APP_RATE_LIMIT_GLOBAL_MAX,
    timeWindow: "1 minute",
    redis: rateLimitRedis,
    nameSpace: "rl:global:",
    skipOnError: true,
    allowList: (req) => {
      // /health → docker/compose probe; /socket.io/* → Engine.IO transport
      // noise, authenticated separately. Everything else falls under the cap.
      return (
        req.url === "/health" ||
        req.url.startsWith("/socket.io/") ||
        req.url === "/metrics"
      );
    },
    errorResponseBuilder: (_req, context) => {
      // The plugin `throws` whatever we return. Fastify's default error
      // handler then serializes an Error as `{statusCode, error, code,
      // message}` where `error` is the HTTP reason phrase ("Too Many
      // Requests") — our own `error: "rate_limited"` property gets
      // clobbered. So we construct an Error for correct status-code
      // propagation, tag it with a sentinel `code` ("RATE_LIMITED"), and
      // let the app-level setErrorHandler (below) rewrite the payload
      // into the `{error:"rate_limited", retryAfter}` shape chat-api.ts
      // already decodes.
      const err = new Error("rate_limited") as Error & {
        statusCode: number;
        code: string;
        retryAfter: number;
      };
      err.statusCode = context.statusCode;
      err.code = "RATE_LIMITED";
      err.retryAfter = Math.ceil(context.ttl / 1000);
      return err;
    },
  });

  // See errorResponseBuilder above — rewrite rate-limit errors into the
  // `{error:"rate_limited", retryAfter}` shape before Fastify's default
  // handler collapses them to `{error:"Too Many Requests", ...}`.
  app.setErrorHandler((err, _request, reply) => {
    const tagged = err as {
      code?: unknown;
      retryAfter?: unknown;
      statusCode?: unknown;
    };
    if (
      tagged.code === "RATE_LIMITED" &&
      typeof tagged.retryAfter === "number"
    ) {
      const status =
        typeof tagged.statusCode === "number" ? tagged.statusCode : 429;
      return reply.status(status).send({
        error: "rate_limited",
        retryAfter: tagged.retryAfter,
      });
    }
    // Fallback: preserve Fastify's default error serialization.
    throw err;
  });

  // REQ-146 — CSRF double-submit on every mutating /api/v1/* request.
  // Registered as `onRequest` so it fires BEFORE body parsing — a missing or
  // mismatched header short-circuits before we drain a potentially 20 MB
  // multipart upload. Exemptions (GET/HEAD/OPTIONS, /api/auth/*, /health,
  // /socket.io/*) live inside csrfPreHandler itself; see lib/csrf.ts.
  app.addHook("onRequest", csrfPreHandler);

  app.get("/health", async () => ({
    status: "ok",
    service: "backend",
    env: env.NODE_ENV,
  }));

  // Specific routes with zod preHandler MUST be registered before the
  // catch-all below so Fastify's router dispatches to them first.
  app.post(
    "/api/auth/sign-up/email",
    { preHandler: zodBodyGuard(registerSchema) },
    proxyToBetterAuth,
  );
  app.post(
    "/api/auth/sign-in/email",
    { preHandler: [zodBodyGuard(loginSchema), deletedAccountGuard] },
    proxyToBetterAuth,
  );

  // App-owned /api/v1/* routes go here, ahead of the catch-all so specific
  // prefixes win. See docs/specs/s1-auth.md task #6a for why sessions is an
  // app route, not a bare better-auth proxy.
  await app.register(sessionsRoutes, { prefix: "/api/v1/sessions" });
  await app.register(messagesRoutes, { prefix: "/api/v1/rooms" });
  await app.register(friendshipRoutes, { prefix: "/api/v1" });
  await app.register(roomsRoutes, { prefix: "/api/v1" });
  await app.register(invitationsRoutes, { prefix: "/api/v1" });
  await app.register(attachmentsRoutes, { prefix: "/api/v1/attachments" });
  await app.register(dmsRoutes, { prefix: "/api/v1/dms" });
  await app.register(adminRoutes, { prefix: "/api/v1/admin" });
  await app.register(accountRoutes, { prefix: "/api/v1" });
  await app.register(readReceiptsRoutes, { prefix: "/api/v1/rooms" });
  await app.register(mutesRoutes, { prefix: "/api/v1/rooms" });

  // REQ-158 — feed the /admin dashboard's errorCount5min widget. onResponse
  // fires for every handled request (including 401/403/404), so we filter
  // via `shouldCountHttpError` to 5xx on user-facing `/api/*` paths only.
  // Excludes `/health` (docker probe noise) and `/socket.io/*` (Engine.IO
  // transport noise). See metrics.ts for the rationale + truth table.
  app.addHook("onResponse", async (request, reply) => {
    if (shouldCountHttpError(reply.statusCode, request.url)) {
      recordHttpError(reply.statusCode);
    }
  });

  // Bridge better-auth's fetch-style handler into Fastify. See ADR-0004.
  // Owns every /api/auth/* path not already declared above.
  app.route({
    method: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    url: "/api/auth/*",
    handler: proxyToBetterAuth,
  });

  // Socket.IO is attached to Fastify's underlying HTTP server. Decorating
  // `app.io` lets routes fan out via `request.server.io.to(roomId).emit(...)`
  // — the io-plumbing pattern from spec §5. Handlers + handshake auth go
  // through the same Fastify instance so tests can drive the full stack via
  // a single `buildApp()`.
  const attached = await createSocketIO(app.server);
  app.decorate("io", attached.io);
  // Presence tracker's default broadcaster needs `io` to fan out per-room
  // `presence.changed` events. Bound once per app (S2 REQ-099..105).
  attachPresenceIO(attached.io);
  installSocketAuth(attached.io);
  attached.io.on("connection", (socket) => {
    registerSocketHandlers(attached.io, socket);
  });
  app.addHook("onClose", async () => {
    await attached.close();
  });

  return app;
}

function zodBodyGuard<T>(schema: ZodType<T>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = schema.safeParse(request.body);
    if (result.success) {
      // Replace the body with the parsed value so downstream handlers see
      // the zod-normalized shape.
      request.body = result.data;
      return;
    }
    reply.status(400).send({
      error: "validation",
      issues: result.error.issues.map((i) => ({
        path: i.path,
        message: i.message,
        code: i.code,
      })),
    });
  };
}

// ─── deleted-account guard (S2-account) ────────────────────────────────────
// REQ-019 — block sign-in for soft-deleted users. Runs BEFORE the better-auth
// proxy so a tombstoned account never gets a fresh session issued.
//
// Pre-auth wrapper was chosen over `databaseHooks.session.create.before`
// (brief §8 fallback) because the better-auth hook fires deep in the sign-in
// pipeline — returning false there leaves the handler's cookie / response
// shape unclear for a user-visible path. A pre-handler that short-circuits
// with a clean 401 is easier to reason about and matches the existing
// zodBodyGuard pattern above. Email anti-enumeration: we return the same
// 401 shape as better-auth's wrong-password path so "account gone" is not
// distinguishable from "never existed" at the HTTP surface.
async function deletedAccountGuard(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  // Body was already parsed + normalized by zodBodyGuard — it's LoginInput.
  const email = (request.body as { email?: unknown })?.email;
  if (typeof email !== "string") return;
  const [row] = await db
    .select({ deletedAt: user.deletedAt })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (row?.deletedAt != null) {
    return reply
      .status(401)
      .send({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" });
  }
}

async function proxyToBetterAuth(request: FastifyRequest, reply: FastifyReply) {
  const url = new URL(
    request.url,
    `http://${request.headers.host ?? "localhost"}`,
  );
  const headers = toFetchHeaders(request);

  const hasBody = !["GET", "HEAD"].includes(request.method);
  const body =
    hasBody && request.body !== undefined
      ? JSON.stringify(request.body)
      : undefined;

  const response = await auth.handler(
    new Request(url.toString(), { method: request.method, headers, body }),
  );

  reply.status(response.status);
  response.headers.forEach((v, k) => reply.header(k, v));

  // REQ-146 — stamp the companion csrf_token cookie whenever better-auth
  // issued a fresh session cookie. The actual cookie name is
  // `better-auth.session_token=` (better-auth namespaces its cookies with
  // the library prefix; confirmed via live-run debug). It only writes this
  // cookie on successful sign-up, sign-in, and token-refresh paths — failed
  // logins and validation errors leave the existing csrf cookie untouched.
  // Hook runs AFTER the response headers have been copied so we don't
  // accidentally drop a better-auth Set-Cookie.
  const outgoingCookies = reply.getHeader("set-cookie");
  const cookieList = Array.isArray(outgoingCookies)
    ? outgoingCookies.map(String)
    : outgoingCookies
      ? [String(outgoingCookies)]
      : [];
  const establishedSession = cookieList.some((c) =>
    /^better-auth\.session_token=/.test(c),
  );
  if (establishedSession) {
    issueCsrfCookie(reply, generateCsrfToken());
  }

  const text = await response.text();
  return reply.send(text.length === 0 ? null : text);
}
