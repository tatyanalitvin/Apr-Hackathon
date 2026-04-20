// REQ-136 — numeric badge for pending incoming friend-request count.
// Zero-count collapses to nothing so the Header doesn't render an empty pill.

import { Badge } from "@/components/ui/badge";

export function PendingBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Badge
      variant="destructive"
      // UX(ui-pass P0-4 residual) — destructive Badge shares the same
      // dark-theme saturation loss as the destructive Button variant: the
      // default `bg-destructive/60` resolves pale on the lavender glass
      // header + tab row. Pin the resting fill at full --destructive and
      // keep the foreground light so the pending-count pill stays red.
      className="h-5 min-w-5 justify-center rounded-full bg-destructive px-1.5 text-xs tabular-nums text-destructive-foreground hover:bg-destructive/90"
      aria-label={`${count} pending friend request${count === 1 ? "" : "s"}`}
    >
      {count > 99 ? "99+" : count}
    </Badge>
  );
}
