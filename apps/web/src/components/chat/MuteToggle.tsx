// REQ-123 — per-room mute control. Bell/BellOff icon + dropdown with fixed
// duration options (1h / 8h / 24h / "until I unmute" = year 2099). Calls
// PUT /rooms/:id/mute with an ISO timestamp or null.
//
// REQ-121 — first click is also the user gesture that unlocks
// Notification.requestPermission(). We only ask once; subsequent clicks no-op
// the prompt if the browser has already answered (granted/denied).

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createChatApi } from "@/lib/socket";
import { cn } from "@/lib/utils";
import { isRoomMuted } from "@/lib/unread";

const DURATIONS: { label: string; hours: number }[] = [
  { label: "1 hour", hours: 1 },
  { label: "8 hours", hours: 8 },
  { label: "24 hours", hours: 24 },
];
// Sentinel "until I unmute" timestamp — a safely-parseable ISO date far in
// the future. Chosen to be well past any conceivable project lifetime but
// still within JS Date range.
const FOREVER_ISO = "2099-12-31T23:59:59.000Z";

export interface MuteToggleProps {
  roomId: string;
  mutedUntil: string | null;
  onChanged: (mutedUntil: string | null) => void;
}

export function MuteToggle({ roomId, mutedUntil, onChanged }: MuteToggleProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const muted = isRoomMuted(mutedUntil);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // REQ-121 — piggyback on the first mute-toggle click to request desktop
  // notification permission. Safe to call repeatedly; the browser fast-paths
  // once a decision is recorded.
  const maybeAskNotifyPermission = useCallback(() => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {});
    }
  }, []);

  const apply = useCallback(
    async (nextIso: string | null) => {
      setPending(true);
      setOpen(false);
      try {
        const api = createChatApi();
        const res = await api.setRoomMute(roomId, nextIso);
        onChanged(res.mutedUntil);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update mute");
      } finally {
        setPending(false);
      }
    },
    [roomId, onChanged],
  );

  const onBellClick = useCallback(() => {
    maybeAskNotifyPermission();
    if (muted) {
      void apply(null);
      return;
    }
    setOpen((v) => !v);
  }, [muted, apply, maybeAskNotifyPermission]);

  const muteFor = useCallback(
    (hours: number) => {
      const ts = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
      void apply(ts);
    },
    [apply],
  );

  const tooltip = muted
    ? `Muted until ${formatMutedUntil(mutedUntil)} — click to unmute`
    : "Mute notifications";

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={muted ? "Unmute room" : "Mute room"}
        title={tooltip}
        onClick={onBellClick}
        disabled={pending}
      >
        {muted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
      </Button>
      {open && !muted ? (
        <div
          role="menu"
          className={cn(
            "absolute right-0 z-20 mt-1 min-w-[10rem] rounded-md border bg-popover p-1 text-sm shadow-md",
          )}
        >
          {DURATIONS.map((d) => (
            <button
              key={d.hours}
              role="menuitem"
              type="button"
              className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent"
              onClick={() => muteFor(d.hours)}
            >
              Mute for {d.label}
            </button>
          ))}
          <button
            role="menuitem"
            type="button"
            className="block w-full rounded px-2 py-1.5 text-left hover:bg-accent"
            onClick={() => apply(FOREVER_ISO)}
          >
            Mute until I unmute
          </button>
        </div>
      ) : null}
    </div>
  );
}

function formatMutedUntil(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (d.getUTCFullYear() >= 2099) return "you unmute it";
  return d.toLocaleString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}
