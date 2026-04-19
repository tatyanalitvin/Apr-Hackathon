import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
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
import { attachmentsRoutes } from "./routes/attachments";
import { dmsRoutes } from "./routes/dms";
import { adminRoutes } from "./routes/admin";
import { accountRoutes } from "./routes/account";
import { recordHttpError, shouldCountHttpError } from "./lib/metrics";
import { createSocketIO, type ChatIOServer } from "./socket";
import { installSocketAuth } from "./socket-auth";
import { registerSocketHandlers } from "./socket-handlers";
import { attachPresenceIO } from "./lib/presence";

declare module "fastify" {
  interface FastifyInstance {
    io: ChatIOServer;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
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
  await app.register(attachmentsRoutes, { prefix: "/api/v1/attachments" });
  await app.register(dmsRoutes, { prefix: "/api/v1/dms" });
  await app.register(adminRoutes, { prefix: "/api/v1/admin" });
  await app.register(accountRoutes, { prefix: "/api/v1" });

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
  const text = await response.text();
  return reply.send(text.length === 0 ? null : text);
}
