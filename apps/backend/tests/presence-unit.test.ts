// REQ-099 — in-memory presence tracker Map semantics.
//
// Unit tests for apps/backend/src/lib/presence.ts. Focuses on the pure
// tracker: refcount on connect/disconnect, setUserState transitions, the
// 2s offline debounce on last-disconnect (so quick reconnects don't flap),
// and the broadcaster emitting only on actual state transitions. No
// Socket.IO, no DB — the tracker takes a plain emit callback. Integration
// with the Socket.IO fan-out lives in presence-io.test.ts (REQ-100).

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createPresenceTracker,
  OFFLINE_DEBOUNCE_MS,
  type PresenceBroadcaster,
} from "../src/lib/presence";

function createSpyBroadcaster(): PresenceBroadcaster & {
  calls: { userId: string; state: "online" | "away" | "offline" }[];
} {
  const calls: { userId: string; state: "online" | "away" | "offline" }[] = [];
  const fn = ((userId, state) => {
    calls.push({ userId, state });
  }) as PresenceBroadcaster & typeof fn;
  (fn as unknown as { calls: typeof calls }).calls = calls;
  return fn as PresenceBroadcaster & { calls: typeof calls };
}

describe("REQ-099 presence Map semantics", () => {
  // Fake timers are opt-in per test. The global setup.ts beforeEach runs
  // BEFORE any of this file's hooks and uses real setTimeouts inside pg/
  // redis truncation, so a fake-timer state leaking across tests would hang
  // the next setup.ts beforeEach at hookTimeout. afterEach resets before
  // vitest's queued beforeEach fires again.
  afterEach(() => {
    vi.useRealTimers();
  });

  test("REQ-099 first connect transitions offline → online and broadcasts once", () => {
    const broadcaster = createSpyBroadcaster();
    const tracker = createPresenceTracker({ broadcaster });

    expect(tracker.getUserState("u1")).toBe("offline");
    tracker.onSocketConnect("u1");

    expect(tracker.getUserState("u1")).toBe("online");
    expect(broadcaster.calls).toEqual([{ userId: "u1", state: "online" }]);
  });

  test("REQ-099 second connect keeps online and does not re-broadcast", () => {
    const broadcaster = createSpyBroadcaster();
    const tracker = createPresenceTracker({ broadcaster });

    tracker.onSocketConnect("u1");
    tracker.onSocketConnect("u1");

    expect(tracker.getUserState("u1")).toBe("online");
    expect(tracker.getConnectedSockets("u1")).toBe(2);
    expect(broadcaster.calls.filter((c) => c.userId === "u1")).toHaveLength(1);
  });

  test("REQ-099 disconnect above zero stays online, no broadcast", () => {
    const broadcaster = createSpyBroadcaster();
    const tracker = createPresenceTracker({ broadcaster });

    tracker.onSocketConnect("u1");
    tracker.onSocketConnect("u1");
    broadcaster.calls.length = 0;

    tracker.onSocketDisconnect("u1");

    expect(tracker.getUserState("u1")).toBe("online");
    expect(tracker.getConnectedSockets("u1")).toBe(1);
    expect(broadcaster.calls).toHaveLength(0);
  });

  test("REQ-099 last disconnect goes offline after debounce window", () => {
    vi.useFakeTimers();
    const broadcaster = createSpyBroadcaster();
    const tracker = createPresenceTracker({ broadcaster });

    tracker.onSocketConnect("u1");
    broadcaster.calls.length = 0;

    tracker.onSocketDisconnect("u1");
    // Still online immediately — debounce not yet elapsed.
    expect(tracker.getUserState("u1")).toBe("online");
    expect(broadcaster.calls).toHaveLength(0);

    vi.advanceTimersByTime(OFFLINE_DEBOUNCE_MS);

    expect(tracker.getUserState("u1")).toBe("offline");
    expect(broadcaster.calls).toEqual([{ userId: "u1", state: "offline" }]);
  });

  test("REQ-099 reconnect within debounce cancels the offline emit", () => {
    vi.useFakeTimers();
    const broadcaster = createSpyBroadcaster();
    const tracker = createPresenceTracker({ broadcaster });

    tracker.onSocketConnect("u1");
    broadcaster.calls.length = 0;
    tracker.onSocketDisconnect("u1");

    // New tab opens before debounce fires.
    vi.advanceTimersByTime(OFFLINE_DEBOUNCE_MS - 1);
    tracker.onSocketConnect("u1");
    vi.advanceTimersByTime(OFFLINE_DEBOUNCE_MS);

    expect(tracker.getUserState("u1")).toBe("online");
    // No offline was ever broadcast; online also shouldn't re-broadcast because
    // we never actually transitioned away from online.
    expect(broadcaster.calls).toHaveLength(0);
  });

  test("REQ-099 setUserState away only fires when connected", () => {
    const broadcaster = createSpyBroadcaster();
    const tracker = createPresenceTracker({ broadcaster });

    // Offline → away: rejected (can't be away without a socket).
    tracker.setUserState("u1", "away");
    expect(tracker.getUserState("u1")).toBe("offline");
    expect(broadcaster.calls).toHaveLength(0);

    tracker.onSocketConnect("u1");
    broadcaster.calls.length = 0;

    tracker.setUserState("u1", "away");
    expect(tracker.getUserState("u1")).toBe("away");
    expect(broadcaster.calls).toEqual([{ userId: "u1", state: "away" }]);
  });

  test("REQ-099 setUserState online overrides away back to online", () => {
    const broadcaster = createSpyBroadcaster();
    const tracker = createPresenceTracker({ broadcaster });

    tracker.onSocketConnect("u1");
    tracker.setUserState("u1", "away");
    broadcaster.calls.length = 0;

    tracker.setUserState("u1", "online");

    expect(tracker.getUserState("u1")).toBe("online");
    expect(broadcaster.calls).toEqual([{ userId: "u1", state: "online" }]);
  });

  test("REQ-099 setUserState to the same state is a no-op", () => {
    const broadcaster = createSpyBroadcaster();
    const tracker = createPresenceTracker({ broadcaster });

    tracker.onSocketConnect("u1");
    broadcaster.calls.length = 0;

    tracker.setUserState("u1", "online"); // already online
    expect(broadcaster.calls).toHaveLength(0);
  });

  test("REQ-099 getUsersPresence returns snapshot for requested userIds", () => {
    const broadcaster = createSpyBroadcaster();
    const tracker = createPresenceTracker({ broadcaster });

    tracker.onSocketConnect("u1");
    tracker.onSocketConnect("u2");
    tracker.setUserState("u2", "away");

    const snapshot = tracker.getUsersPresence(["u1", "u2", "u3"]);

    expect(snapshot.get("u1")).toBe("online");
    expect(snapshot.get("u2")).toBe("away");
    // Never-seen user defaults to offline.
    expect(snapshot.get("u3")).toBe("offline");
  });

  test("REQ-099 lastUpdate is an ISO timestamp string on every transition", () => {
    const broadcaster = createSpyBroadcaster();
    const tracker = createPresenceTracker({ broadcaster });

    tracker.onSocketConnect("u1");
    const entry = tracker.peek("u1");

    expect(entry).not.toBeNull();
    expect(typeof entry?.lastUpdate).toBe("string");
    expect(() => new Date(entry!.lastUpdate)).not.toThrow();
    expect(Number.isNaN(new Date(entry!.lastUpdate).getTime())).toBe(false);
  });
});
