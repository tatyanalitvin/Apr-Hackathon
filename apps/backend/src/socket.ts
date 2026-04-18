// Socket.IO server + Redis adapter for multi-process fan-out.
// Imports verified via Context7 (2026-04-18).
//
// Redis adapter is wired for horizontal scale (spec §5 "io plumbing"). In the
// single-process S1 deploy it's redundant but harmless; it also keeps the
// test rig parity with prod. Test isolation (truncate + flushdb between tests)
// is handled in tests/setup.ts.

import type { Server as HTTPServer } from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient, type RedisClientType } from "redis";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@ai-herders/shared";
import { env } from "./env";

export type ChatIOServer = Server<ClientToServerEvents, ServerToClientEvents>;

export interface AttachedIO {
  io: ChatIOServer;
  close: () => Promise<void>;
}

export async function createSocketIO(httpServer: HTTPServer): Promise<AttachedIO> {
  const io: ChatIOServer = new Server(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: true,
    },
  });

  const pubClient: RedisClientType = createClient({ url: env.REDIS_URL });
  const subClient: RedisClientType = pubClient.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));

  const close = async (): Promise<void> => {
    // Order matters: close io first so no new emits fire, then drop the
    // Redis adapter's pub/sub sockets. `io.close()` also closes all sockets.
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await pubClient.quit().catch(() => {});
    await subClient.quit().catch(() => {});
  };

  return { io, close };
}
