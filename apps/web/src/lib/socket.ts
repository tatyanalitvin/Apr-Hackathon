import { io, type Socket } from "socket.io-client";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  FriendRequestAcceptedEvent,
  PresenceChangedEvent,
} from "@ai-herders/shared/protocol";
import { BACKEND_URL } from "./backend";
import { RealChatAPI } from "./chat-api";
import type { ChatAPI } from "./chat-api";
import { friendshipEvents } from "./friendship-events";
import { presenceStore } from "./presence-store";

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

// REQ-105 — pipe server `presence.changed` events into the client store.
// PresencePill components subscribe per-userId via useSyncExternalStore, so
// one bridge covers every pill that happens to be mounted.
export function attachPresenceBus(socket: ChatSocket): () => void {
  const handler = (evt: PresenceChangedEvent) => presenceStore.apply(evt);
  socket.on("presence.changed", handler);
  return () => {
    socket.off("presence.changed", handler);
  };
}
