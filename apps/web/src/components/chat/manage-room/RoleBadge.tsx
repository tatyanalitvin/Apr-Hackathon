// REQ-209 — small shadcn Badge wrapper for the per-row role label. Members
// render nothing so plain-member-heavy rosters don't look like a column of
// gray pills; owner/admin are differentiated by Badge variant.

"use client";

import { Badge } from "@/components/ui/badge";
import type { RoomRole } from "@/lib/chat-api";

export function RoleBadge({ role }: { role: RoomRole }): React.ReactElement | null {
  if (role === "owner") return <Badge variant="default">Owner</Badge>;
  if (role === "admin") return <Badge variant="secondary">Admin</Badge>;
  return null;
}
