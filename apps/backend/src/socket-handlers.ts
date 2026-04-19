// Socket.IO event handlers — R6 (REQ-034), R11 (REQ-040), R12 (REQ-041).
//
// room.subscribe: membership check against the DB, then socket.join(roomId).
// The ack returns the current messageSeq.seq so clients can prime
// lastSeenSeq without an extra round-trip (watermark protocol, ADR-0003).
//
// room.unsubscribe: socket.leave(roomId). No ack (per ClientToServerEvents).
//
// Non-members receive ack({ ok: false, roomHeadSeq: "0" }) rather than a
// thrown error — the contract in `protocol.ts` is `(res: { ok; roomHeadSeq })`
// so we stay on-shape and let the client decide how to surface it. (Same
// 401/403 rationale as the REST routes.)
//
// Presence (REQ-041): on connect we io.emit presence.state online, on
// disconnect we emit offline. Fanout is global per spec §8 Q2 option (a) —
// S1 has one public room so this is effectively room-scoped anyway; scoping
// to shared rooms is deferred to S2 per §7. Multi-tab flap (one user +
// two sockets) is a known S1 limitation — tests must use distinct users.

import type { Socket } from "socket.io";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { messageSeq, roomMember } from "@ai-herders/shared/schema";
import type {
  ClientToServerEvents,
  PresenceStateEvent,
  ServerToClientEvents,
} from "@ai-herders/shared/protocol";

import { db } from "./db";
import { recordUserConnect, recordUserDisconnect } from "./lib/metrics";
import {
  onSocketConnect as presenceOnSocketConnect,
  onSocketDisconnect as presenceOnSocketDisconnect,
  setUserState as presenceSetUserState,
} from "./lib/presence";
import type { ChatIOServer } from "./socket";

// Validates the `presence.setState` inbound payload. Brief §1a: clients may
// only assert online/away — offline is derived strictly from socket refcount.
const presenceSetStateSchema = z.object({
  state: z.enum(["online", "away"]),
});

type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

function presenceEvent(userId: string, state: "online" | "offline"): PresenceStateEvent {
  return {
    type: "presence.state",
    userId,
    state,
    since: new Date().toISOString(),
  };
}

export function registerSocketHandlers(io: ChatIOServer, socket: ChatSocket): void {
  const userId = socket.data.userId;
  if (userId) {
    // REQ-158 admin tap: refcount this user's live sockets so the admin
    // dashboard's "online users" widget reflects distinct users (not raw
    // sockets). Multi-tab = one online user; see metrics.ts OnlineUserMap.
    // Kept OUTSIDE the presence broadcast block so a future split between
    // presence fanout and admin-count semantics stays readable.
    recordUserConnect(userId);
    io.emit("presence.state", presenceEvent(userId, "online"));
    // ─── presence (S2-presence REQ-099..105) ─────────────────────────
    // Parallel to the S1 global `presence.state` emit above. The tracker
    // fans out room-scoped `presence.changed` with the richer away-aware
    // model; the S1 event remains for backwards-compat consumers until
    // it's retired.
    presenceOnSocketConnect(userId);
    // ────────────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      recordUserDisconnect(userId);
      io.emit("presence.state", presenceEvent(userId, "offline"));
      // ─── presence (S2-presence REQ-099..105) ───────────────────────
      presenceOnSocketDisconnect(userId);
      // ──────────────────────────────────────────────────────────────
    });

    socket.on("presence.setState", (payload) => {
      // Validate against the zod shape, then route through the tracker.
      // Malformed payloads are silently ignored — Socket.IO doesn't carry
      // an ack channel for this event (see protocol.ts), so there's no
      // place to surface an error. Misbehaving clients log a soft warning
      // via the existing pino logger (added in S3 hardening path).
      const parsed = presenceSetStateSchema.safeParse(payload);
      if (!parsed.success) return;
      presenceSetUserState(userId, parsed.data.state);
    });
  }


  socket.on("room.subscribe", async (roomId, ack) => {
    const userId = socket.data.userId;
    if (!userId) {
      ack({ ok: false, roomHeadSeq: "0" });
      return;
    }

    const [membership] = await db
      .select({ id: roomMember.id })
      .from(roomMember)
      .where(and(eq(roomMember.roomId, roomId), eq(roomMember.userId, userId)))
      .limit(1);
    if (!membership) {
      ack({ ok: false, roomHeadSeq: "0" });
      return;
    }

    const [seqRow] = await db
      .select({ seq: messageSeq.seq })
      .from(messageSeq)
      .where(eq(messageSeq.roomId, roomId))
      .limit(1);
    const roomHeadSeq = seqRow?.seq ?? 0n;

    await socket.join(roomId);
    ack({ ok: true, roomHeadSeq: roomHeadSeq.toString() });
  });

  socket.on("room.unsubscribe", (roomId) => {
    void socket.leave(roomId);
  });
}
