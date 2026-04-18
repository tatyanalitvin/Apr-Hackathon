// Custom Next.js + Socket.IO server
// See https://nextjs.org/docs/app/guides/custom-server
//
// Entry point for `node server.js` (after `tsc`) or `ts-node server.ts` in dev.
// Why a custom server: Socket.IO needs to share the HTTP server with Next so
// the WebSocket upgrade works without a separate port.

import { createServer } from "node:http";
import next from "next";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

async function main() {
  await app.prepare();

  const httpServer = createServer((req, res) => handle(req, res));
  const io = new SocketIOServer(httpServer, {
    cors: { origin: false }, // same-origin only
  });

  // Redis adapter — lets presence and message fan-out work across multiple app instances.
  // For the hackathon single-instance setup it's still useful as a persistent pubsub backend.
  const pubClient = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379" });
  const subClient = pubClient.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));

  io.on("connection", (socket) => {
    // TODO: authenticate socket via cookie-session token (see docs/specs/realtime.md)
    // TODO: join user room `user:<id>` and subscribed chat rooms `room:<id>`
    // TODO: emit presence updates via Redis (see §2.2)
    // eslint-disable-next-line no-console
    console.log(`[io] connected ${socket.id}`);

    socket.on("disconnect", (reason) => {
      // eslint-disable-next-line no-console
      console.log(`[io] disconnected ${socket.id} (${reason})`);
    });
  });

  httpServer.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`> Ready on http://${hostname}:${port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
