import { io, type Socket } from "socket.io-client";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  FriendRequestAcceptedEvent,
} from "@ai-herders/shared/protocol";
import { BACKEND_URL } from "./backend";
import { RealChatAPI } from "./chat-api";
import type { ChatAPI } from "./chat-api";
import { friendshipEvents } from "./friendship-events";

export type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function createChatSocket(): ChatSocket {
  return io(BACKEND_URL, {
    withCredentials: true,
    transports: ["websocket"],
  });
}

export function createChatApi(): ChatAPI {
  return new RealChatAPI();
}

// REQ-058 — bridge the socket's friend.request.accepted event into the
// in-memory bus. Callers get back an unsubscribe fn for useEffect cleanup.
// No watermark, no backfill — the bus is a fanout, not a log.
export function attachFriendshipBus(socket: ChatSocket): () => void {
  const handler = (evt: FriendRequestAcceptedEvent) =>
    friendshipEvents.dispatch(evt);
  socket.on("friend.request.accepted", handler);
  return () => {
    socket.off("friend.request.accepted", handler);
  };
}
