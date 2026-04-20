// Fastify entry — the chat server backend.
// Responsibilities (wired incrementally through S1–S3):
//   - /health         (now)
//   - auth bridge to better-auth (S1)
//   - POST /api/v1/rooms/:id/messages with atomic seq allocator (S1)
//   - GET  /api/v1/rooms/:id/messages history slice for gap-detection (S1)
//   - Socket.IO room.subscribe/unsubscribe + message.new broadcast (S1)
//   - POST /api/v1/files/upload, GET /api/v1/files/:id streaming (S2)
//   - Rate limiter via @fastify/rate-limit + Redis (S3)
//   - CSP/HSTS headers (S3)
//
// Socket.IO is attached inside buildApp() so `app.io` is available to routes
// for fan-out. We only need to listen on the HTTP port here.

import { buildApp } from "./app";
import { env } from "./env";
import { logger } from "./lib/logger";
import { createShutdownHandler } from "./lib/shutdown";

// docker stop's default grace window is 10s before SIGKILL; exit well
// before that so onClose hooks (socket.io, redis, pg pool) finish cleanly.
const SHUTDOWN_BUDGET_MS = 8_000;

async function main() {
  const app = await buildApp();
  await app.listen({ host: "0.0.0.0", port: env.PORT });
  app.log.info({ port: env.PORT }, "backend ready");

  const shutdown = createShutdownHandler({
    app,
    budgetMs: SHUTDOWN_BUDGET_MS,
    exit: process.exit,
  });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "backend fatal");
  process.exit(1);
});
