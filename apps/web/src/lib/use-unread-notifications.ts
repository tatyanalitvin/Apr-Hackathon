// REQ-121 / REQ-122 / REQ-124 — cross-cutting notification side-effects
// driven by the caller's current unread list.
//
//  * REQ-122 title flash: when the tab is not focused AND there are unread
//    messages in non-muted rooms, prepend "(N) " to the document title.
//  * REQ-121 desktop notification: best-effort fire on new-message bumps
//    while the tab is unfocused, gated on Notification.permission === "granted".
//  * REQ-124 cross-tab dedupe: the frontmost/focused tab claims the
//    "notifier" role over BroadcastChannel("unread") at a steady heartbeat.
//    Background tabs back off and stop firing desktop notifications so the
//    user doesn't get three pings per message.
//
// Hook is read-only w.r.t. backend state — it only observes the room
// summary list and the caller's focus state. Ack/mark-read stays with
// use-mark-read.ts.

"use client";

import { useEffect, useRef } from "react";
import type { MyRoomSummary } from "@/lib/chat-api";
import {
  computeUnreadList,
  totalUnreadForAlerts,
  type UnreadEntry,
} from "@/lib/unread";

const BASE_TITLE = "AI Herders Jam";
const CHANNEL_NAME = "unread";
// Heartbeat at 2s — well below the human-perceptible "this tab stopped
// updating" threshold, and cheap compared to any real work.
const HEARTBEAT_MS = 2000;
// If no heartbeat arrives for this long we assume no other tab is focused
// and this tab (even if unfocused) may fire desktop notifications.
const STALE_MS = 5000;

export interface UseUnreadNotificationsOptions {
  rooms: MyRoomSummary[] | null;
  // The roomId of the currently open room, so we can suppress the badge
  // count for the in-view room (the in-room UX is its own signal).
  currentRoomId: string;
}

type HeartbeatMsg = { type: "heartbeat"; ts: number; tabId: string };

export function useUnreadNotifications({
  rooms,
  currentRoomId,
}: UseUnreadNotificationsOptions) {
  // Keep a stable per-tab id so BroadcastChannel can distinguish heartbeats.
  const tabIdRef = useRef<string>(makeTabId());
  // Track last-seen counts per-room so we fire a desktop notification only
  // on the *delta* (new messages arriving while away), not on every render.
  const lastCountsRef = useRef<Map<string, number>>(new Map());
  // Most recent heartbeat we've heard from another tab — drives the
  // "only frontmost tab notifies" rule.
  const peerHeartbeatAtRef = useRef<number>(0);
  // Remember the original document.title so we can restore it when unread
  // goes back to zero, even if other code has mutated it (unlikely here).
  const baseTitleRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (baseTitleRef.current === null) {
      // Strip any lingering "(N) " prefix from a previous mount.
      baseTitleRef.current = document.title.replace(/^\(\d+\)\s+/, "") || BASE_TITLE;
    }
  }, []);

  // --- BroadcastChannel heartbeat ------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL_NAME);

    const onMessage = (evt: MessageEvent<HeartbeatMsg>) => {
      const msg = evt.data;
      if (!msg || msg.type !== "heartbeat") return;
      if (msg.tabId === tabIdRef.current) return;
      peerHeartbeatAtRef.current = Date.now();
    };
    channel.addEventListener("message", onMessage);

    const interval = setInterval(() => {
      // Only the focused tab broadcasts. Background tabs stay silent so the
      // focused tab's heartbeat is the one that "wins".
      if (document.visibilityState === "visible" && document.hasFocus()) {
        channel.postMessage({
          type: "heartbeat",
          ts: Date.now(),
          tabId: tabIdRef.current,
        } as HeartbeatMsg);
      }
    }, HEARTBEAT_MS);

    return () => {
      channel.removeEventListener("message", onMessage);
      channel.close();
      clearInterval(interval);
    };
  }, []);

  // --- Title flash + desktop notifications ---------------------------------
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!rooms) return;

    const entries: UnreadEntry[] = computeUnreadList(rooms);
    // For the title and desktop prompts we want to *exclude* the currently-
    // open room (the user is looking at it — it's not a pending alert).
    const alertable = entries.filter((e) => e.id !== currentRoomId && !e.muted);
    const total = totalUnreadForAlerts(alertable);

    const base = baseTitleRef.current ?? BASE_TITLE;
    document.title = total > 0 ? `(${total > 99 ? "99+" : total}) ${base}` : base;

    // Fire desktop notifications only when:
    //  - this tab is unfocused (otherwise the user can see the badge)
    //  - another tab isn't actively claiming the notifier role (stale peer)
    //  - we have permission; and there are actual *new* messages since last tick
    const unfocused =
      document.visibilityState !== "visible" || !document.hasFocus();
    const peerFresh = Date.now() - peerHeartbeatAtRef.current < STALE_MS;
    const canNotify =
      unfocused &&
      !peerFresh &&
      typeof window !== "undefined" &&
      "Notification" in window &&
      Notification.permission === "granted";

    if (canNotify) {
      for (const e of alertable) {
        const prev = lastCountsRef.current.get(e.id) ?? 0;
        if (e.count > prev) {
          try {
            const n = new Notification(`#${e.name}`, {
              body: `${e.count} new message${e.count === 1 ? "" : "s"}`,
              tag: `unread:${e.id}`,
            });
            // Focus the window when the user clicks a notification.
            n.onclick = () => {
              window.focus();
              n.close();
            };
          } catch {
            // Some browsers throw if permission was revoked mid-session.
          }
        }
      }
    }

    // Sync the per-room counts cache regardless of whether we notified — we
    // don't want a flood of catch-up notifications once the tab regains
    // focus or permission is granted.
    const next = new Map<string, number>();
    for (const e of entries) next.set(e.id, e.count);
    lastCountsRef.current = next;

    return () => {
      // Best-effort: restore base title when the dep tuple changes. The
      // next render will re-compute immediately, so this mostly matters
      // for unmount.
      document.title = baseTitleRef.current ?? BASE_TITLE;
    };
  }, [rooms, currentRoomId]);
}

function makeTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}
