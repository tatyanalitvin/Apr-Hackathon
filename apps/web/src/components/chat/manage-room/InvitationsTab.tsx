// REQ-089 — manage-room Invitations tab. Owners/admins of private rooms
// send invites by username; the tab lists pending outgoing invites and
// offers a Cancel (DELETE /invitations/:id, R7) button. Refreshes on send,
// cancel, and on the two relevant socket events (invitation.accepted +
// invitation.declined from the per-user channel) so state stays consistent
// without polling.
//
// Binding: docs/specs/s2-invitations.md §6 "InvitationsTab.tsx". The Cancel
// button exercises the §5 fanout asymmetry (inviter-cancel → invitee
// channel, §4 R7).

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createChatApi,
  createChatSocket,
  type ChatSocket,
} from "@/lib/socket";
import type { InvitationError, OutgoingInvitation } from "@/lib/chat-api";

interface InvitationsTabProps {
  roomId: string;
}

export function InvitationsTab({ roomId }: InvitationsTabProps) {
  // ManageRoomModal only renders this tab for owners today (agent A's
  // wave will introduce an "admin" role alongside owner); the server is
  // the authoritative gate via R3 (forbidden_role → toast if the user
  // somehow calls here without permission), so the input is always shown.
  const [api] = useState(() => createChatApi());
  const [username, setUsername] = useState("");
  const [sending, setSending] = useState(false);
  const [invites, setInvites] = useState<OutgoingInvitation[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Inline field error under the username input for the zod `inviteeUsername`
  // miss. Cleared on edit so stale copy doesn't linger across retries.
  const [usernameError, setUsernameError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const rows = await api.listRoomInvitations(roomId);
      setInvites(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load invitations");
    } finally {
      setLoading(false);
    }
  }, [api, roomId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Keep the outgoing list fresh when the invitee responds. Both events
  // carry an invitationId; we filter client-side rather than refetching for
  // a cheaper, flicker-free update.
  useEffect(() => {
    const socket: ChatSocket = createChatSocket();
    const removeById = (invitationId: string) =>
      setInvites((prev) => prev.filter((r) => r.id !== invitationId));
    const onAccepted = (evt: { invitationId: string; roomId: string }): void => {
      if (evt.roomId === roomId) removeById(evt.invitationId);
    };
    const onDeclined = (evt: { invitationId: string; roomId: string }): void => {
      if (evt.roomId === roomId) removeById(evt.invitationId);
    };
    socket.on("room.invitation.accepted", onAccepted);
    socket.on("room.invitation.declined", onDeclined);
    return () => {
      socket.off("room.invitation.accepted", onAccepted);
      socket.off("room.invitation.declined", onDeclined);
      socket.disconnect();
    };
  }, [roomId]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = username.trim().replace(/^@/, "");
    if (!trimmed) {
      toast.error("Enter a username to invite.");
      return;
    }
    setSending(true);
    const r = await api.sendInvitation(roomId, trimmed);
    setSending(false);
    if (r.ok) {
      setUsername("");
      toast.success(`Invite sent to @${trimmed}.`);
      void refetch();
      return;
    }
    mapErrorToToast(r.error, trimmed);
  }

  async function handleCancel(invitationId: string, inviteeUsername: string) {
    setCancelling(invitationId);
    const r = await api.cancelInvitation(invitationId);
    setCancelling(null);
    if (r.ok) {
      setInvites((prev) => prev.filter((row) => row.id !== invitationId));
      toast.success(`Invite to @${inviteeUsername} cancelled.`);
      return;
    }
    mapErrorToToast(r.error, inviteeUsername);
    // Refresh on any failure — the server state might have diverged
    // (e.g. invitee accepted between our render and click).
    void refetch();
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="space-y-2">
        <Label htmlFor="invite-username">Invite by username</Label>
        <div className="flex gap-2">
          <Input
            id="invite-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="alice"
            autoComplete="off"
            disabled={sending}
            maxLength={64}
          />
          <Button
            type="submit"
            disabled={sending}
            // UX(ui-pass P1-8) — primary submit ghosts out via opacity-50
            // while the POST is in flight; pin the primary fill at a softer
            // tint with full light text so the action stays visible.
            className="disabled:bg-primary/70 disabled:text-primary-foreground disabled:opacity-100"
          >
            {sending ? "Sending…" : "Send invite"}
          </Button>
        </div>
      </form>

      <div className="space-y-2">
        <div className="text-sm font-medium">Pending invitations</div>
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : invites.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No pending invitations.
          </div>
        ) : (
          <ul className="divide-y rounded-md border">
            {invites.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="flex flex-col text-sm">
                  <span>@{row.inviteeUsername}</span>
                  <span className="text-xs text-muted-foreground">
                    by @{row.inviterUsername} ·{" "}
                    {new Date(row.createdAt).toLocaleString()}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCancel(row.id, row.inviteeUsername)}
                  disabled={cancelling === row.id}
                >
                  {cancelling === row.id ? "Cancelling…" : "Cancel"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function mapErrorToToast(error: InvitationError, ctx: string): void {
  switch (error.code) {
    case "unauthorized":
      toast.error("Please sign in again.");
      return;
    case "room_not_found":
      toast.error("Room no longer exists.");
      return;
    case "not_a_member":
      toast.error("You are no longer a member of this room.");
      return;
    case "forbidden_role":
      toast.error("Only owners and admins can invite to a private room.");
      return;
    case "invitee_not_found":
      toast.error(`No user named @${ctx}.`);
      return;
    case "invitee_already_member":
      toast.error(`@${ctx} is already in this room.`);
      return;
    case "invitee_banned":
      toast.error(`@${ctx} is banned from this room.`);
      return;
    case "invite_pending":
      toast.error(`@${ctx} already has a pending invitation.`);
      return;
    case "invitation_not_found":
      toast.error("That invitation no longer exists.");
      return;
    case "not_inviter":
      toast.error("Only the sender can cancel an invitation.");
      return;
    case "invitation_not_pending":
      toast.error("Invitation has already been responded to.");
      return;
    case "validation":
      toast.error(error.message ?? "That username is not valid.");
      return;
    case "network":
      toast.error("Network error — try again.");
      return;
    default:
      toast.error("Couldn't complete invitation — try again.");
  }
}
