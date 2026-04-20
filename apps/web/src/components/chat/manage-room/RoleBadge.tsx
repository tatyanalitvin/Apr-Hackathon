// REQ-209 — small shadcn Badge wrapper for the per-row role label. Owner and
// admin use the accented Badge variants; plain members get a muted pill so the
// ROLE column still carries information on member-heavy rosters instead of
// rendering empty cells (UI-pass P2-9).

"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RoomRole } from "@/lib/chat-api";

export function RoleBadge({ role }: { role: RoomRole }): React.ReactElement | null {
  if (role === "owner") return <Badge variant="default">Owner</Badge>;
  if (role === "admin") return <Badge variant="secondary">Admin</Badge>;
  if (role === "member") {
    return (
      <Badge
        variant="outline"
        className={cn("border-transparent bg-muted text-muted-foreground")}
      >
        Member
      </Badge>
    );
  }
  return null;
}
