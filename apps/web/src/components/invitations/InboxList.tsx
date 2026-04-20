// REQ-089 — client-side inbox for incoming room invitations. Rendered as a
// collapsible panel above the sidebar RoomList. Shows pending invites with
// Accept/Decline buttons; socket-driven refresh on `room.invitation.sent`.
// On accept, the invitee's /rooms/me list invalidates via the onAccepted
// callback so the newly-joined room appears in the sidebar.
//
// Binding: docs/specs/s2-invitations.md §6 "InboxList.tsx".

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  createChatApi,
  createChatSocket,
  type ChatSocket,
} from "@/lib/socket";
import type { InboxInvitation, InvitationError } from "@/lib/chat-api";
import type {
  RoomInvitationDeclinedEvent,
  RoomInvitationSentEvent,
} from "@ai-herders/shared/protocol";

interface InboxListProps {
  /** Called after an invite is accepted so the parent can refresh /rooms/me. */
  onAccepted?: (roomId: string) => void;
}

export function InboxList({ onAccepted }: InboxListProps) {
  const router = useRouter();
  const [api] = useState(() => createChatApi());
  const [rows, setRows] = useState<InboxInvitation[]>([]);
  const [busy, setBusy] = useState<{ id: string; kind: "accept" | "decline" } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const socketRef = useRef<ChatSocket | null>(null);

  const refetch = useCallback(async () => {
    try {
      const invitations = await api.listInbox();
      setRows(invitations);
    } catch {
      /* Soft-fail: a transient fetch error shouldn't wipe the currently-
         rendered list. Next socket event or action will re-fetch. */
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    const socket = createChatSocket();
    socketRef.current = socket;

    // Real-time append on new incoming invite. Also handles the decline
    // event (which, per R7 asymmetry, invitee receives for inviter-cancel)
    // by dropping the row.
    const onSent = (evt: RoomInvitationSentEvent): void => {
      setRows((prev) => {
        if (prev.some((r) => r.id === evt.invitationId)) return prev;
        const next: InboxInvitation = {
          id: evt.invitationId,
          roomId: evt.roomId,
          roomName: evt.roomName,
          inviterUsername: evt.inviterUsername,
          createdAt: evt.createdAt,
          expiresAt: evt.expiresAt,
        };
        return [next, ...prev];
      });
    };
    const onDeclined = (evt: RoomInvitationDeclinedEvent): void => {
      setRows((prev) => prev.filter((r) => r.id !== evt.invitationId));
    };
    socket.on("room.invitation.sent", onSent);
    socket.on("room.invitation.declined", onDeclined);

    // Refresh on reconnect — at-most-once fanout can drop events under
    // disconnects (same reasoning as friend.request.accepted in
    // ContactsClient).
    const onReconnect = () => void refetch();
    socket.io.on("reconnect", onReconnect);

    return () => {
      socket.off("room.invitation.sent", onSent);
      socket.off("room.invitation.declined", onDeclined);
      socket.io.off("reconnect", onReconnect);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [refetch]);

  async function handleAccept(row: InboxInvitation) {
    setBusy({ id: row.id, kind: "accept" });
    const r = await api.acceptInvitation(row.id);
    setBusy(null);
    if (r.ok) {
      setRows((prev) => prev.filter((x) => x.id !== row.id));
      toast.success(`Joined #${row.roomName}.`);
      onAccepted?.(r.data.roomId);
      router.push(`/rooms/${r.data.roomId}`);
      return;
    }
    mapErrorToToast(r.error, row.roomName);
    if (r.error.code === "invitation_not_found" || r.error.code === "invitation_not_pending") {
      setRows((prev) => prev.filter((x) => x.id !== row.id));
    }
  }

  async function handleDecline(row: InboxInvitation) {
    setBusy({ id: row.id, kind: "decline" });
    const r = await api.declineInvitation(row.id);
    setBusy(null);
    if (r.ok) {
      setRows((prev) => prev.filter((x) => x.id !== row.id));
      // Mirror Accept's success toast (line above) — without this,
      // Decline was silent and the user had to infer success from the
      // row disappearing.
      toast.success("Invitation declined.");
      return;
    }
    mapErrorToToast(r.error, row.roomName);
    if (r.error.code === "invitation_not_found" || r.error.code === "invitation_not_pending") {
      setRows((prev) => prev.filter((x) => x.id !== row.id));
    }
  }

  if (!loaded || rows.length === 0) return null;

  return (
    <div
      className="border-b bg-muted/30 p-3"
      data-testid="inbox-list"
      aria-label="Pending room invitations"
    >
      <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">
        Invitations
      </div>
      <ul className="space-y-2">
        {rows.map((row) => {
          const expiry = formatExpiry(row.expiresAt);
          return (
            <li
              key={row.id}
              className="rounded-md border bg-background px-3 py-2 text-sm"
              data-testid={`inbox-invitation-${row.id}`}
            >
              <div className="mb-1.5 flex flex-col">
                <span className="font-medium">#{row.roomName}</span>
                <span className="text-xs text-muted-foreground">
                  from @{row.inviterUsername}
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => handleAccept(row)}
                  disabled={busy?.id === row.id}
                >
                  {busy?.id === row.id && busy.kind === "accept"
                    ? "Accepting…"
                    : "Accept"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDecline(row)}
                  disabled={busy?.id === row.id}
                >
                  {busy?.id === row.id && busy.kind === "decline"
                    ? "Declining…"
                    : "Decline"}
                </Button>
              </div>
              {expiry ? (
                <div
                  className={`mt-1.5 text-xs ${
                    expiry.urgent ? "text-destructive" : "text-muted-foreground"
                  }`}
                  data-testid={`inbox-invitation-expiry-${row.id}`}
                >
                  {expiry.label}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Render invitation expiry as a short human phrase. Uses built-in
// Intl.RelativeTimeFormat so we don't add a dayjs/date-fns dep. Returns
// null when the ISO string is unparseable or the invite has already
// expired — the row will be cleaned up server-side either way, so we
// don't need to label it.
function formatExpiry(iso: string): { label: string; urgent: boolean } | null {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return null;
  const deltaMs = target - Date.now();
  if (deltaMs <= 0) return { label: "Expired", urgent: true };

  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  let label: string;
  if (deltaMs >= DAY) {
    const days = Math.round(deltaMs / DAY);
    label = `Expires ${fmt.format(days, "day")}`;
  } else if (deltaMs >= HOUR) {
    const hours = Math.round(deltaMs / HOUR);
    label = `Expires ${fmt.format(hours, "hour")}`;
  } else if (deltaMs >= MINUTE) {
    const mins = Math.round(deltaMs / MINUTE);
    label = `Expires ${fmt.format(mins, "minute")}`;
  } else {
    label = "Expires in under a minute";
  }
  // Under 24h remaining → warn tone. Uses the destructive token already
  // used elsewhere in this file for terminal error copy.
  return { label, urgent: deltaMs < DAY };
}

function mapErrorToToast(error: InvitationError, roomName: string): void {
  switch (error.code) {
    case "unauthorized":
      toast.error("Please sign in again.");
      return;
    case "invitation_not_found":
      toast.error("Invitation no longer exists.");
      return;
    case "invitation_not_pending":
      toast.error("Invitation already responded to.");
      return;
    case "not_invitee":
      toast.error("This invitation isn't addressed to you.");
      return;
    case "network":
      toast.error("Network error — try again.");
      return;
    default:
      toast.error(`Couldn't update invitation to #${roomName}.`);
  }
}
