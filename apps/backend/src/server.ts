// Fastify entry — the chat server backend.
// Responsibilities (wired incrementally through S1–S3):
//   - /health         (now)
//   - auth bridge to better-auth (S1)
//   - POST /api/v1/rooms/:id/messages with atomic seq allocator (S1)
//   - GET  /api/v1/rooms/:id/messages history slice for gap-detection (S1)
//   - POST /api/v1/files/upload, GET /api/v1/files/:id streaming (S2)
//   - Rate limiter via @fastify/rate-limit + Redis (S3)
//   - CSP/HSTS headers (S3)

import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "./env";
import { createSocketIO } from "./socket";

async function main() {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    trustProxy: true,
  });

  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "backend",
    env: env.NODE_ENV,
  }));

  // Attach Socket.IO to Fastify's underlying HTTP server BEFORE listen().
  // `app.ready()` ensures plugins are loaded; then we grab the raw node server.
  await app.ready();

  const io = await createSocketIO(app.server);
  io.on("connection", (socket) => {
    app.log.info({ sid: socket.id }, "socket connected");
    socket.on("disconnect", (reason) => {
      app.log.info({ sid: socket.id, reason }, "socket disconnected");
    });
  });

  await app.listen({ host: "0.0.0.0", port: env.PORT });
  app.log.info({ port: env.PORT }, "backend ready");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[backend] fatal:", err);
  process.exit(1);
});
