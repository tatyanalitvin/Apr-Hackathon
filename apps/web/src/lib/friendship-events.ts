// REQ-058 in-memory event bus for friend.request.accepted.
//
// The socket fires a single "friend.request.accepted" event per accept; one
// listener on the socket dispatches into this bus so multiple UI surfaces
// (toast + Friends-tab refetcher + Outgoing-tab refetcher) can react without
// fighting over the socket handler. Keeps socket.ts pure wiring.

import type { FriendRequestAcceptedEvent } from "@ai-herders/shared/protocol";

type Listener = (evt: FriendRequestAcceptedEvent) => void;

const listeners = new Set<Listener>();

export const friendshipEvents = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  dispatch(evt: FriendRequestAcceptedEvent): void {
    for (const l of listeners) l(evt);
  },
  // Test-only — clears all listeners between cases.
  _reset(): void {
    listeners.clear();
  },
};
