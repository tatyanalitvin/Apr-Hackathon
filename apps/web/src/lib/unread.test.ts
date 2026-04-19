// REQ-120 / REQ-123 — unit coverage for the pure unread helpers. These
// guard the arithmetic that drives both RoomList badges and the global
// title-flash / desktop-notification gating, so the edge cases (dormant
// users with no reads, past `mutedUntil`, stringified-bigint overflow)
// live here.

import { describe, it, expect } from "vitest";
import type { MyRoomSummary } from "./chat-api";
import {
  computeUnreadForRoom,
  computeUnreadList,
  isRoomMuted,
  totalUnreadForAlerts,
} from "./unread";

function room(partial: Partial<MyRoomSummary>): MyRoomSummary {
  return {
    id: "r",
    name: "room",
    kind: "group",
    visibility: "public",
    description: null,
    lastReadSeq: "0",
    roomHeadSeq: "0",
    mutedUntil: null,
    ...partial,
  };
}

describe("REQ-123 isRoomMuted", () => {
  const now = Date.parse("2026-04-19T12:00:00Z");

  it("treats null/undefined as unmuted", () => {
    expect(isRoomMuted(null, now)).toBe(false);
    expect(isRoomMuted(undefined, now)).toBe(false);
  });

  it("treats a past timestamp as unmuted (no sweeper needed)", () => {
    expect(isRoomMuted("2026-04-19T11:00:00Z", now)).toBe(false);
  });

  it("treats a future timestamp as muted", () => {
    expect(isRoomMuted("2026-04-19T13:00:00Z", now)).toBe(true);
  });

  it("treats a bad timestamp as unmuted", () => {
    expect(isRoomMuted("not-a-date", now)).toBe(false);
  });
});

describe("REQ-120 computeUnreadForRoom", () => {
  it("returns head - lastRead when head is ahead", () => {
    const entry = computeUnreadForRoom(room({ roomHeadSeq: "10", lastReadSeq: "7" }));
    expect(entry.count).toBe(3);
  });

  it("clamps to zero when lastRead has caught up or passed head", () => {
    const entry = computeUnreadForRoom(room({ roomHeadSeq: "5", lastReadSeq: "5" }));
    expect(entry.count).toBe(0);
    const entry2 = computeUnreadForRoom(room({ roomHeadSeq: "3", lastReadSeq: "9" }));
    expect(entry2.count).toBe(0);
  });

  it("handles bigint-string inputs beyond Number.MAX_SAFE_INTEGER", () => {
    const head = "9007199254740999"; // MAX_SAFE_INTEGER + 7
    const read = "9007199254740990"; // MAX_SAFE_INTEGER - 2
    const entry = computeUnreadForRoom(room({ roomHeadSeq: head, lastReadSeq: read }));
    expect(entry.count).toBe(9);
  });

  it("propagates mute state from mutedUntil", () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const entry = computeUnreadForRoom(room({ mutedUntil: future }));
    expect(entry.muted).toBe(true);
  });
});

describe("REQ-120 / REQ-123 totalUnreadForAlerts", () => {
  it("sums unread across rooms and skips muted ones", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const list = computeUnreadList([
      room({ id: "a", roomHeadSeq: "5", lastReadSeq: "3" }), // 2
      room({ id: "b", roomHeadSeq: "10", lastReadSeq: "9" }), // 1
      room({ id: "c", roomHeadSeq: "100", lastReadSeq: "0", mutedUntil: future }), // 100, muted
    ]);
    expect(totalUnreadForAlerts(list)).toBe(3);
  });

  it("returns 0 for an all-caught-up feed", () => {
    const list = computeUnreadList([
      room({ id: "a", roomHeadSeq: "5", lastReadSeq: "5" }),
      room({ id: "b", roomHeadSeq: "0", lastReadSeq: "0" }),
    ]);
    expect(totalUnreadForAlerts(list)).toBe(0);
  });
});
