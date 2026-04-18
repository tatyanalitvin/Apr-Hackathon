// Socket.IO server + Redis adapter for multi-process fan-out.
// Imports verified via Context7 (2026-04-18).

import type { Server as HTTPServer } from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@ai-herders/shared";
import { env } from "./env";

export type ChatIOServer = Server<ClientToServerEvents, ServerToClientEvents>;

export async function createSocketIO(httpServer: HTTPServer): Promise<ChatIOServer> {
  const io: ChatIOServer = new Server(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: true,
    },
  });

  const pubClient = createClient({ url: env.REDIS_URL });
  const subClient = pubClient.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));

  return io;
}
