// REQ-211 — Banned list tab. Owner/admin viewer only; plain member (should
// never reach here given the ManageRoomModal gate) sees a placeholder. Rows
// carry the banner + reason + date; [Unban] fires REQ-205. Live updates: when
// another admin unbans (or when the bannedBy-emit feedback arrives), the
// room.member.unbanned socket event removes the matching row optimistically.

"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createChatApi, createChatSocket } from "@/lib/socket";
import type {
  BanListItem,
  ChatAPI,
  ModerationMutationError,
  RoomRole,
} from "@/lib/chat-api";
import type { RoomMemberUnbannedEvent } from "@ai-herders/shared/protocol";

interface BannedTabProps {
  roomId: string;
  viewerRole: RoomRole;
}

export function BannedTab({ roomId, viewerRole }: BannedTabProps) {
  const [api] = useState<ChatAPI>(() => createChatApi());
  const [bans, setBans] = useState<BanListItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const canView = useMemo(
    () => viewerRole === "owner" || viewerRole === "admin",
    [viewerRole],
  );

  async function refresh() {
    try {
      const rows = await api.listRoomBans(roomId);
      setBans(rows);
    } catch (err) {
      console.error("[BannedTab] listRoomBans failed", err);
      toast.error("Couldn't load ban list.");
    }
  }

  useEffect(() => {
    if (!canView) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, canView]);

  // Subscribe to room.member.unbanned so an unban performed by a co-admin on
  // another browser tab removes the row here without a manual refresh. We
  // intentionally open a dedicated socket for this tab rather than threading
  // the parent RoomClient socket through the modal tree — small surface, only
  // lives while the tab is mounted, and dies on close via the cleanup.
  useEffect(() => {
    if (!canView) return;
    const socket = createChatSocket();
    const handler = (evt: RoomMemberUnbannedEvent) => {
      if (evt.roomId !== roomId) return;
      setBans((prev) =>
        prev ? prev.filter((b) => b.userId !== evt.userId) : prev,
      );
    };
    socket.on("room.member.unbanned", handler);
    return () => {
      socket.off("room.member.unbanned", handler);
      socket.disconnect();
    };
  }, [roomId, canView]);

  async function handleUnban(ban: BanListItem) {
    const confirmed =
      typeof window !== "undefined" &&
      window.confirm(
        `Unban @${ban.username}? They will be able to rejoin this room.`,
      );
    if (!confirmed) return;
    setBusy(ban.userId);
    const r = await api.unbanMember(roomId, ban.userId);
    setBusy(null);
    if (r.ok) {
      toast.success(`Unbanned @${ban.username}.`);
      setBans((prev) => (prev ? prev.filter((b) => b.userId !== ban.userId) : prev));
      return;
    }
    surfaceErr(r.error);
  }

  if (!canView) {
    return (
      <div className="text-sm text-muted-foreground">
        Only admins can view the ban list.
      </div>
    );
  }
  if (bans === null) {
    return <div className="text-sm text-muted-foreground">Loading ban list…</div>;
  }
  if (bans.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">No banned users.</div>
    );
  }

  return (
    <div className="overflow-hidden rounded border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Username</th>
            <th className="px-3 py-2 text-left font-medium">Banned by</th>
            <th className="px-3 py-2 text-left font-medium">Date</th>
            <th className="px-3 py-2 text-left font-medium">Reason</th>
            <th className="px-3 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {bans.map((b) => {
            const busyRow = busy === b.userId;
            const when = new Date(b.bannedAt);
            return (
              <tr key={b.userId} className="border-t" data-testid={`ban-row-${b.username}`}>
                <td className="px-3 py-2 align-middle">@{b.username}</td>
                <td className="px-3 py-2 align-middle text-muted-foreground">
                  @{b.bannedByUsername}
                </td>
                <td className="px-3 py-2 align-middle text-xs text-muted-foreground">
                  {when.toLocaleString()}
                </td>
                <td className="px-3 py-2 align-middle text-muted-foreground">
                  {b.reason ?? "—"}
                </td>
                <td className="px-3 py-2 align-middle text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleUnban(b)}
                    disabled={busyRow}
                    data-testid={`unban-${b.username}`}
                  >
                    Unban
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function surfaceErr(err: ModerationMutationError): void {
  switch (err.code) {
    case "ban_not_found":
      toast.error("Ban already lifted.");
      break;
    case "not_admin":
      toast.error("Only owners and admins can unban.");
      break;
    case "room_not_found":
      toast.error("Room no longer exists.");
      break;
    case "unauthorized":
      toast.error("Please sign in again.");
      break;
    case "network":
      toast.error("Network error — try again.");
      break;
    default:
      toast.error("Couldn't unban — try again.");
  }
}
