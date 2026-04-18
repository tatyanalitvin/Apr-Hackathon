import { io, type Socket } from "socket.io-client";
import type { ServerToClientEvents, ClientToServerEvents } from "@ai-herders/shared/protocol";
import { BACKEND_URL } from "./backend";
import { RealChatAPI } from "./chat-api";
import type { ChatAPI } from "./chat-api";

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
