// REQ-105 — presence dot for MembersList + Header.
//
// Subscribes per-userId via presenceStore so this component only re-renders
// on its subject's transitions. Colors follow the brief §1:
//   online  → green  (bg-green-500)
//   away    → amber  (bg-amber-400)
//   offline → gray   (bg-muted-foreground/40)
//
// Sized smaller than a full Badge so it works inline next to the avatar.

"use client";

import { useSyncExternalStore } from "react";
import type { UserPresenceState } from "@ai-herders/shared/protocol";
import { presenceStore } from "@/lib/presence-store";

const COLOR: Record<UserPresenceState, string> = {
  online: "bg-green-500",
  away: "bg-amber-400",
  offline: "bg-muted-foreground/40",
};

const LABEL: Record<UserPresenceState, string> = {
  online: "online",
  away: "away",
  offline: "offline",
};

export function usePresence(userId: string): UserPresenceState {
  return useSyncExternalStore(
    (cb) => presenceStore.subscribe(userId, cb),
    () => presenceStore.getState(userId),
    () => "offline",
  );
}

export function PresencePill({
  userId,
  state: override,
  className = "",
}: {
  userId: string;
  // Escape hatch for forcing a state (used by Header self-pill which drives
  // state from the local idle detector, not the presence-store).
  state?: UserPresenceState;
  className?: string;
}) {
  const storeState = usePresence(userId);
  const state = override ?? storeState;

  // Online pills get a soft pulsing halo via .presence-halo::after. The
  // ::after background uses currentColor, so we forward `text-green-500` on
  // the same span to colour the ring without leaking into siblings.
  const haloClass = state === "online" ? "presence-halo text-green-500" : "";

  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${COLOR[state]} ${haloClass} ${className}`}
      aria-label={LABEL[state]}
      title={LABEL[state]}
    />
  );
}
