// REQ-105 — client-side presence store.
//
// Small subscribable Map<userId, UserPresenceState>. Apply a
// `presence.changed` payload to move a user through its state, and emit to
// every subscriber listening on that userId (and to global listeners for
// roster-level re-renders). Mirrors the friendship-events bus pattern but
// per-userId so a PresencePill component only re-renders on changes for
// its own subject.

import { describe, test, expect, beforeEach, vi } from "vitest";
import type { PresenceChangedEvent } from "@ai-herders/shared/protocol";
import { presenceStore } from "./presence-store";

function evt(
  userId: string,
  state: "online" | "away" | "offline",
): PresenceChangedEvent {
  return {
    type: "presence.changed",
    userId,
    state,
    updatedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  presenceStore._reset();
});

describe("REQ-105 presence-store Map + subscribers", () => {
  test("REQ-105 defaults unknown users to offline", () => {
    expect(presenceStore.getState("user-unknown")).toBe("offline");
  });

  test("REQ-105 apply updates state returned by getState", () => {
    presenceStore.apply(evt("user-1", "online"));
    expect(presenceStore.getState("user-1")).toBe("online");
    presenceStore.apply(evt("user-1", "away"));
    expect(presenceStore.getState("user-1")).toBe("away");
    presenceStore.apply(evt("user-1", "offline"));
    expect(presenceStore.getState("user-1")).toBe("offline");
  });

  test("REQ-105 subscribe fires listener on matching-userId updates only", () => {
    const listener = vi.fn();
    const off = presenceStore.subscribe("user-1", listener);

    presenceStore.apply(evt("user-2", "online"));
    expect(listener).not.toHaveBeenCalled();

    presenceStore.apply(evt("user-1", "online"));
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    presenceStore.apply(evt("user-1", "away"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("REQ-105 apply is idempotent — same state does not re-notify", () => {
    presenceStore.apply(evt("user-1", "online"));
    const listener = vi.fn();
    presenceStore.subscribe("user-1", listener);

    presenceStore.apply(evt("user-1", "online"));

    expect(listener).not.toHaveBeenCalled();
  });

  test("REQ-105 multiple listeners all get notified", () => {
    const a = vi.fn();
    const b = vi.fn();
    presenceStore.subscribe("user-1", a);
    presenceStore.subscribe("user-1", b);

    presenceStore.apply(evt("user-1", "online"));

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
