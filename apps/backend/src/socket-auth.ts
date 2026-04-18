// Socket.IO handshake auth middleware (R9 / REQ-038).
//
// Reads the HTTP cookie sent during the WebSocket upgrade, bounces it through
// better-auth's session lookup (same pattern as message-auth.ts / routes/sessions.ts)
// and stashes the userId on `socket.data.userId`. Connections without a valid
// session are rejected at handshake time — `next(new Error(...))` resolves to
// `connect_error` on the client.

import type { Socket } from "socket.io";
import { auth } from "./auth";
import type { ChatIOServer } from "./socket";

declare module "socket.io" {
  interface SocketData {
    userId: string;
  }
}

function cookieHeaderFrom(socket: Socket): string | undefined {
  const raw = socket.handshake.headers.cookie;
  if (Array.isArray(raw)) return raw.join("; ");
  return raw;
}

export function installSocketAuth(io: ChatIOServer): void {
  io.use(async (socket, next) => {
    try {
      const cookie = cookieHeaderFrom(socket);
      if (!cookie) {
        next(new Error("unauthorized"));
        return;
      }
      const headers = new Headers();
      headers.set("cookie", cookie);
      const session = await auth.api.getSession({ headers });
      if (!session) {
        next(new Error("unauthorized"));
        return;
      }
      socket.data.userId = session.user.id;
      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error("auth failed"));
    }
  });
}
