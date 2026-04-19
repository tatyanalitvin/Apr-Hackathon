// REQ-120 / REQ-123 — pure derivation helpers for per-room unread state.
// Shared between RoomClient (renders the RoomList badges) and the
// use-unread-notifications hook (sums across rooms for title-flash /
// desktop-notification gating). No React imports here — keep it pure so the
// unit surface is trivial to reason about.

import type { MyRoomSummary } from "@/lib/chat-api";

export interface UnreadEntry {
  id: string;
  name: string;
  count: number;
  muted: boolean;
}

// `mutedUntil` is an ISO string or null. Past timestamps drift to unmuted
// without a server sweeper (see routes/mutes.ts). `now` is injected so the
// helper is deterministic in tests.
export function isRoomMuted(
  mutedUntil: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!mutedUntil) return false;
  const ts = Date.parse(mutedUntil);
  if (Number.isNaN(ts)) return false;
  return ts > now;
}

export function computeUnreadForRoom(
  room: MyRoomSummary,
  now: number = Date.now(),
): UnreadEntry {
  const head = safeBigInt(room.roomHeadSeq);
  const read = safeBigInt(room.lastReadSeq);
  const delta = head > read ? Number(head - read) : 0;
  return {
    id: room.id,
    name: room.name,
    count: delta,
    muted: isRoomMuted(room.mutedUntil, now),
  };
}

export function computeUnreadList(
  rooms: MyRoomSummary[],
  now: number = Date.now(),
): UnreadEntry[] {
  return rooms.map((r) => computeUnreadForRoom(r, now));
}

// Sum of unread counts from rooms that are NOT currently muted — this is
// the number that drives title flash / desktop notifications.
export function totalUnreadForAlerts(entries: UnreadEntry[]): number {
  let out = 0;
  for (const e of entries) {
    if (e.muted) continue;
    out += e.count;
  }
  return out;
}

function safeBigInt(s: string | undefined | null): bigint {
  if (!s) return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}
