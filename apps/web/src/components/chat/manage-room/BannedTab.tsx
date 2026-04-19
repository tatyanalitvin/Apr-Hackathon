// TODO(agent-A): REQ-??? — banned-users list with unban action.
// Placeholder; owner agent fills.

"use client";

interface BannedTabProps {
  roomId: string;
}

export function BannedTab({ roomId }: BannedTabProps) {
  void roomId;
  return (
    <div className="text-sm text-muted-foreground">Banned users — coming soon.</div>
  );
}
