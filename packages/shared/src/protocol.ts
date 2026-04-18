// Socket.IO protocol — shared event typing between web client and Fastify backend.
//
// Watermark contract (see docs/adr/0003-watermark-protocol.md in S1):
//   - Every broadcast event in a room carries {seq, roomHeadSeq}.
//   - Client tracks lastSeenSeq per room. If received.seq !== lastSeen + 1,
//     client calls `GET /api/v1/rooms/:id/messages?fromSeq=lastSeen+1&toSeq=received.seq`
//     BEFORE resuming the live stream.
//   - bigints are serialized as strings on the wire to survive JSON.

export const PROTOCOL_VERSION = 1;

export type PresenceState = "online" | "afk" | "offline";

// ──────────────────────────────────────────────────────────────────────────
// Wire-format payload types
// ──────────────────────────────────────────────────────────────────────────

export interface MessagePayload {
  id: string;
  roomId: string;
  authorId: string;
  body: string;
  seq: string;        // bigint as string
  replyToId: string | null;
  editedAt: string | null;
  createdAt: string;
}

export interface MessageNewEvent {
  type: "message.new";
  roomId: string;
  seq: string;          // bigint as string — same as message.seq
  roomHeadSeq: string;  // current watermark for the room
  message: MessagePayload;
}

export interface MessageEditedEvent {
  type: "message.edited";
  roomId: string;
  seq: string;
  roomHeadSeq: string;
  messageId: string;
  body: string;
  editedAt: string;
}

export interface MessageDeletedEvent {
  type: "message.deleted";
  roomId: string;
  seq: string;
  roomHeadSeq: string;
  messageId: string;
}

export interface PresenceStateEvent {
  type: "presence.state";
  userId: string;
  state: PresenceState;
  since: string; // ISO timestamp
}

export interface TypingEvent {
  type: "typing";
  roomId: string;
  userId: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Socket.IO event maps — feed to `new Server<ClientToServerEvents, ServerToClientEvents>`
// ──────────────────────────────────────────────────────────────────────────

export interface ServerToClientEvents {
  "message.new": (evt: MessageNewEvent) => void;
  "message.edited": (evt: MessageEditedEvent) => void;
  "message.deleted": (evt: MessageDeletedEvent) => void;
  "presence.state": (evt: PresenceStateEvent) => void;
  "typing": (evt: TypingEvent) => void;
}

export interface ClientToServerEvents {
  "room.subscribe": (roomId: string, ack: (res: { ok: boolean; roomHeadSeq: string }) => void) => void;
  "room.unsubscribe": (roomId: string) => void;
  "presence.set": (state: Exclude<PresenceState, "offline">) => void;
  "typing.start": (roomId: string) => void;
  "typing.stop": (roomId: string) => void;
}

// ──────────────────────────────────────────────────────────────────────────
// REST history response (used by gap-detection)
// ──────────────────────────────────────────────────────────────────────────

export interface HistorySliceResponse {
  roomId: string;
  fromSeq: string;
  toSeq: string;
  roomHeadSeq: string;
  messages: MessagePayload[];
}
