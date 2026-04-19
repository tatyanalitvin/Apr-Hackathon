// REQ-136 — numeric badge for pending incoming friend-request count.
// Zero-count collapses to nothing so the Header doesn't render an empty pill.

import { Badge } from "@/components/ui/badge";

export function PendingBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Badge
      variant="destructive"
      className="h-5 min-w-5 justify-center rounded-full px-1.5 text-xs tabular-nums"
      aria-label={`${count} pending friend request${count === 1 ? "" : "s"}`}
    >
      {count > 99 ? "99+" : count}
    </Badge>
  );
}
