import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FriendRequestAcceptedEvent } from "@ai-herders/shared/protocol";
import { friendshipEvents } from "./friendship-events";
import { attachFriendshipBus } from "./socket";

beforeEach(() => {
  friendshipEvents._reset();
});

function sampleEvent(): FriendRequestAcceptedEvent {
  return {
    type: "friend.request.accepted",
    requestId: "req-1",
    friendId: "user-bob",
    friendUsername: "bob",
    acceptedAt: "2026-04-19T10:00:00.000Z",
  };
}

describe("REQ-058 — friendship event bus", () => {
  it("delivers a dispatched event to a subscribed listener", () => {
    const listener = vi.fn();
    friendshipEvents.subscribe(listener);
    const evt = sampleEvent();
    friendshipEvents.dispatch(evt);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(evt);
  });

  it("stops delivery after unsubscribe returns", () => {
    const listener = vi.fn();
    const off = friendshipEvents.subscribe(listener);
    off();
    friendshipEvents.dispatch(sampleEvent());
    expect(listener).not.toHaveBeenCalled();
  });

  it("fans out to every active listener", () => {
    const a = vi.fn();
    const b = vi.fn();
    friendshipEvents.subscribe(a);
    friendshipEvents.subscribe(b);
    friendshipEvents.dispatch(sampleEvent());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("attachFriendshipBus wires socket friend.request.accepted into the bus", () => {
    const handlers = new Map<string, (evt: unknown) => void>();
    const fakeSocket = {
      on(name: string, handler: (evt: unknown) => void) {
        handlers.set(name, handler);
      },
      off(name: string) {
        handlers.delete(name);
      },
    };
    const listener = vi.fn();
    friendshipEvents.subscribe(listener);

    const detach = attachFriendshipBus(fakeSocket as Parameters<typeof attachFriendshipBus>[0]);

    const evt = sampleEvent();
    handlers.get("friend.request.accepted")?.(evt);
    expect(listener).toHaveBeenCalledWith(evt);

    detach();
    expect(handlers.has("friend.request.accepted")).toBe(false);
  });
});
