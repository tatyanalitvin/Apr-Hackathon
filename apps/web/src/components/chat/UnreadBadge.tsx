// REQ-120 — tiny pill rendered next to a room name in RoomList when the
// caller has unread messages. `count = roomHeadSeq - lastReadSeq`.
//
// Muted rooms still get a badge, but in a neutral gray (brief §3 pre-resolved
// Q6 — "User sees there's activity, just no interruption"). Current room uses
// the destructive variant so the visual survives a rare race where a message
// arrives in the current room faster than the mark-read debounce can fire.

"use client";

import { cn } from "@/lib/utils";

export function UnreadBadge({
  count,
  muted,
  current,
  className,
}: {
  count: number;
  muted?: boolean;
  current?: boolean;
  className?: string;
}) {
  if (count <= 0) return null;
  const display = count > 99 ? "99+" : String(count);
  const tone = muted
    ? "bg-muted text-muted-foreground"
    : current
      ? "bg-destructive text-destructive-foreground"
      : "bg-primary text-primary-foreground";
  return (
    <span
      className={cn(
        "inline-flex min-w-[1.25rem] justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none",
        tone,
        className,
      )}
      aria-label={`${count} unread`}
    >
      {display}
    </span>
  );
}
