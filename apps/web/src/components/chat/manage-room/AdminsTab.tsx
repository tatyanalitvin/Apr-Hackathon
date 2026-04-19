// TODO(agent-A): REQ-??? — promote/demote admins, owner-only UI.
// Placeholder; owner agent fills.

"use client";

interface AdminsTabProps {
  roomId: string;
}

export function AdminsTab({ roomId }: AdminsTabProps) {
  void roomId;
  return (
    <div className="text-sm text-muted-foreground">Admins — coming soon.</div>
  );
}
