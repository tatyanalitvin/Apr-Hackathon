// REQ-105 — client-side presence store.
//
// Keeps a per-userId `UserPresenceState` snapshot and notifies subscribers
// on change. PresencePill components subscribe per-userId so the whole
// MembersList doesn't re-render on every transition. Apply(...) is the
// single entry point; `socket.ts` wires the `presence.changed` event into
// it. Same shape as friendship-events (subscribe-returns-unsubscribe)
// so the subscription pattern is consistent across the app.

import type {
  PresenceChangedEvent,
  UserPresenceState,
} from "@ai-herders/shared/protocol";

type Listener = (state: UserPresenceState) => void;

const states = new Map<string, UserPresenceState>();
const listeners = new Map<string, Set<Listener>>();

export const presenceStore = {
  getState(userId: string): UserPresenceState {
    return states.get(userId) ?? "offline";
  },

  subscribe(userId: string, listener: Listener): () => void {
    let set = listeners.get(userId);
    if (!set) {
      set = new Set();
      listeners.set(userId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) listeners.delete(userId);
    };
  },

  apply(evt: PresenceChangedEvent): void {
    const prev = states.get(evt.userId) ?? "offline";
    if (prev === evt.state) return;
    states.set(evt.userId, evt.state);
    const set = listeners.get(evt.userId);
    if (!set) return;
    for (const l of set) l(evt.state);
  },

  // Test-only — clears map + listeners between cases.
  _reset(): void {
    states.clear();
    listeners.clear();
  },
};
