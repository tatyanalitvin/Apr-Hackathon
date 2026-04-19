// TODO(agent-A): REQ-??? — members list with role badges and kick action.
// Placeholder; owner agent fills. Uses `roomId` to scope the fetch.

"use client";

interface MembersTabProps {
  roomId: string;
}

export function MembersTab({ roomId }: MembersTabProps) {
  void roomId;
  return (
    <div className="text-sm text-muted-foreground">Members — coming soon.</div>
  );
}
