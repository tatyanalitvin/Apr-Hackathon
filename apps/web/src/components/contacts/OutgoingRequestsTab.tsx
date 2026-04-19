// R15 — read-only view of pending requests the caller has sent. Shows the
// target user + "pending" state. No cancel/resend action (spec §7 leaves
// cancel as a follow-up; re-send is REQ-055 / the dialog).

"use client";

import { Hourglass } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import type { OutgoingFriendRequest } from "@/lib/friendship-api";

interface OutgoingTabProps {
  requests: OutgoingFriendRequest[];
  loading: boolean;
}

export function OutgoingRequestsTab({ requests, loading }: OutgoingTabProps) {
  if (loading && requests.length === 0) {
    return <div className="py-8 text-sm text-muted-foreground">Loading sent requests…</div>;
  }
  if (requests.length === 0) {
    return (
      <div className="py-8 text-sm text-muted-foreground">
        Nothing pending. Requests you send show up here until they&apos;re accepted.
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1" aria-label="Outgoing friend requests">
      {requests.map((r) => (
        <li
          key={r.id}
          className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2"
        >
          <Avatar className="h-9 w-9">
            <AvatarFallback>{r.to.name.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium">{r.to.name}</div>
            <div className="truncate text-xs text-muted-foreground">@{r.to.username}</div>
          </div>
          <Badge variant="secondary" className="shrink-0 gap-1">
            <Hourglass className="h-3 w-3" /> Pending
          </Badge>
        </li>
      ))}
    </ul>
  );
}
