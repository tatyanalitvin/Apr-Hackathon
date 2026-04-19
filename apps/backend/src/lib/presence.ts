// REQ-099..105 — in-memory user presence tracker.
//
// Model: per-user { state, connectedSockets, lastUpdate, pendingOfflineTimer }.
// Refcounted socket connections: first connect → online, last disconnect → a
// 2s debounced transition to offline (cancel-on-reconnect so multi-tab
// reload blips don't flap). Explicit setUserState("away") is the idle
// detector's hook; it only sticks while connectedSockets > 0. Explicit
// setUserState("online") overrides away back to online.
//
// Intentional separation of concerns:
//   - The tracker is a pure module. It takes a `broadcaster` callback so
//     unit tests can assert transitions without spinning up Socket.IO.
//   - Room-scoped fanout (Socket.IO + room_member query) lives in the
//     module-level wiring at the bottom. socket-handlers.ts consumes the
//     default singleton; integration tests in presence-io.test.ts exercise
//     the end-to-end path with real sockets.
//
// This is in-memory only per memory `project-edge-cases`: restart = every
// user resets to offline, reconnects re-establish. No Redis pub/sub for
// multi-process fanout in S2 — explicit follow-up for scale.
//
// Parallel to the S1 `recordUserConnect`/`recordUserDisconnect` surface in
// lib/metrics.ts. That one counts distinct online users for the admin
// dashboard; this one carries the richer away-aware model plus the
// client → server `presence.setState` contract. Both live side-by-side.

import { eq, inArray } from "drizzle-orm";
import { roomMember } from "@ai-herders/shared/schema";
import type {
  PresenceChangedEvent,
  UserPresenceState,
} from "@ai-herders/shared/protocol";

import { db } from "../db";
import type { ChatIOServer } from "../socket";

export const OFFLINE_DEBOUNCE_MS = 2_000;

export type PresenceBroadcaster = (
  userId: string,
  state: UserPresenceState,
  updatedAt: string,
) => void;

interface PresenceEntry {
  state: UserPresenceState;
  connectedSockets: number;
  lastUpdate: string;
  offlineTimer?: ReturnType<typeof setTimeout>;
}

export interface PresenceTracker {
  onSocketConnect(userId: string): void;
  onSocketDisconnect(userId: string): void;
  setUserState(userId: string, state: "online" | "away"): void;
  getUserState(userId: string): UserPresenceState;
  getConnectedSockets(userId: string): number;
  getUsersPresence(userIds: string[]): Map<string, UserPresenceState>;
  peek(userId: string): PresenceEntry | null;
  reset(): void;
}

export interface PresenceTrackerOptions {
  broadcaster?: PresenceBroadcaster;
  // Test seam — lets unit tests inject a deterministic clock without also
  // faking setTimeout (which vi.useFakeTimers covers).
  now?: () => number;
}

export function createPresenceTracker(
  options: PresenceTrackerOptions = {},
): PresenceTracker {
  const broadcaster = options.broadcaster ?? noopBroadcaster;
  const nowFn = options.now ?? Date.now;
  const states = new Map<string, PresenceEntry>();

  const entryFor = (userId: string): PresenceEntry => {
    let entry = states.get(userId);
    if (!entry) {
      entry = {
        state: "offline",
        connectedSockets: 0,
        lastUpdate: new Date(nowFn()).toISOString(),
      };
      states.set(userId, entry);
    }
    return entry;
  };

  const transition = (
    userId: string,
    entry: PresenceEntry,
    next: UserPresenceState,
  ): void => {
    if (entry.state === next) return;
    entry.state = next;
    entry.lastUpdate = new Date(nowFn()).toISOString();
    broadcaster(userId, next, entry.lastUpdate);
  };

  const cancelPendingOffline = (entry: PresenceEntry): void => {
    if (entry.offlineTimer !== undefined) {
      clearTimeout(entry.offlineTimer);
      entry.offlineTimer = undefined;
    }
  };

  return {
    onSocketConnect(userId) {
      const entry = entryFor(userId);
      entry.connectedSockets += 1;
      cancelPendingOffline(entry);
      if (entry.state === "offline") {
        transition(userId, entry, "online");
      }
    },

    onSocketDisconnect(userId) {
      const entry = states.get(userId);
      if (!entry || entry.connectedSockets === 0) return;
      entry.connectedSockets -= 1;
      if (entry.connectedSockets > 0) return;

      // Debounce: the last socket just dropped, but a reconnect within the
      // window (tab refresh, quick navigation) should keep the user online.
      cancelPendingOffline(entry);
      entry.offlineTimer = setTimeout(() => {
        entry.offlineTimer = undefined;
        if (entry.connectedSockets === 0 && entry.state !== "offline") {
          transition(userId, entry, "offline");
        }
      }, OFFLINE_DEBOUNCE_MS);
    },

    setUserState(userId, state) {
      const entry = states.get(userId);
      // Can't be away without a live socket; can't be online if you have no
      // connection either. Both branches are silent no-ops — the caller is
      // the client side, which is not authoritative about connection state.
      if (!entry || entry.connectedSockets === 0) return;
      transition(userId, entry, state);
    },

    getUserState(userId) {
      return states.get(userId)?.state ?? "offline";
    },

    getConnectedSockets(userId) {
      return states.get(userId)?.connectedSockets ?? 0;
    },

    getUsersPresence(userIds) {
      const out = new Map<string, UserPresenceState>();
      for (const id of userIds) {
        out.set(id, states.get(id)?.state ?? "offline");
      }
      return out;
    },

    peek(userId) {
      return states.get(userId) ?? null;
    },

    reset() {
      for (const entry of states.values()) cancelPendingOffline(entry);
      states.clear();
    },
  };
}

function noopBroadcaster(): void {
  /* intentional */
}

// ──────────────────────────────────────────────────────────────────────────
// Process-wide singleton + Socket.IO fanout wiring.
//
// socket-handlers.ts calls onSocketConnect/onSocketDisconnect + handles the
// `presence.setState` inbound event; those go through the module-level
// wrappers below so test isolation (reset) and production use share the
// same tracker instance per process.
// ──────────────────────────────────────────────────────────────────────────

let ioRef: ChatIOServer | null = null;

function defaultBroadcaster(
  userId: string,
  state: UserPresenceState,
  updatedAt: string,
): void {
  if (!ioRef) return;
  const evt: PresenceChangedEvent = {
    type: "presence.changed",
    userId,
    state,
    updatedAt,
  };
  // Fan out to every room the user is a member of. Query is small (userIds
  // have at most a few dozen room memberships for the hackathon scope);
  // doing it per-transition keeps us from having to mirror roster state
  // into the tracker itself.
  void db
    .select({ roomId: roomMember.roomId })
    .from(roomMember)
    .where(eq(roomMember.userId, userId))
    .then((rows) => {
      for (const row of rows) {
        ioRef!.to(row.roomId).emit("presence.changed", evt);
      }
    })
    .catch(() => {
      // Swallow — presence is best-effort, missed emits reconcile on next
      // /rooms/me fetch or room.subscribe ack.
    });
}

const defaultTracker = createPresenceTracker({ broadcaster: defaultBroadcaster });

/**
 * Bind the Socket.IO server instance used by the default broadcaster.
 * Called once from app.ts after createSocketIO() resolves.
 */
export function attachPresenceIO(io: ChatIOServer): void {
  ioRef = io;
}

export function onSocketConnect(userId: string): void {
  defaultTracker.onSocketConnect(userId);
}

export function onSocketDisconnect(userId: string): void {
  defaultTracker.onSocketDisconnect(userId);
}

export function setUserState(userId: string, state: "online" | "away"): void {
  defaultTracker.setUserState(userId, state);
}

export function getUserState(userId: string): UserPresenceState {
  return defaultTracker.getUserState(userId);
}

/**
 * Returns a Map<userId, state> for the members of the given rooms.
 * Callers typically use this to prime a freshly-rendered member sidebar.
 */
export async function getUsersInRooms(
  roomIds: string[],
): Promise<Map<string, UserPresenceState>> {
  if (roomIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: roomMember.userId })
    .from(roomMember)
    .where(inArray(roomMember.roomId, roomIds));
  const userIds = Array.from(new Set(rows.map((r) => r.userId)));
  return defaultTracker.getUsersPresence(userIds);
}

/**
 * Test-only — drains the singleton between test files. Vitest runs backend
 * tests in a single fork, so without this the previous file's presence
 * entries (and pending offline timers) would leak forward.
 */
export function __resetPresenceForTests(): void {
  defaultTracker.reset();
}
