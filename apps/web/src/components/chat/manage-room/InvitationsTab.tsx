// TODO(agent-B): REQ-??? — pending invitations sent/received for this room.
// Placeholder; owner agent fills.

"use client";

interface InvitationsTabProps {
  roomId: string;
}

export function InvitationsTab({ roomId }: InvitationsTabProps) {
  void roomId;
  return (
    <div className="text-sm text-muted-foreground">Invitations — coming soon.</div>
  );
}
