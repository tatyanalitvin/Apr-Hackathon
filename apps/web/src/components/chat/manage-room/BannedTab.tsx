// REQ-211 — Banned list tab. Owner/admin viewer only; plain member (should
// never reach here given the ManageRoomModal gate) sees a placeholder. Rows
// carry the banner + reason + date; [Unban] opens a styled shadcn Dialog
// confirm (UnbanConfirmDialog) that fires REQ-205. Live updates: when another
// admin unbans (or when the bannedBy-emit feedback arrives), the
// room.member.unbanned socket event removes the matching row optimistically.

"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  roomName?: string;
  viewerRole: RoomRole;
}

type UnbanTarget = { userId: string; username: string } | null;

export function BannedTab({ roomId, roomName, viewerRole }: BannedTabProps) {
  const [api] = useState<ChatAPI>(() => createChatApi());
  const [bans, setBans] = useState<BanListItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unbanTarget, setUnbanTarget] = useState<UnbanTarget>(null);

  const canView = useMemo(
    () => viewerRole === "owner" || viewerRole === "admin",
    [viewerRole],
  );

  async function refresh() {
    setError(null);
    try {
      const rows = await api.listRoomBans(roomId);
      setBans(rows);
    } catch (err) {
      console.error("[BannedTab] listRoomBans failed", err);
      const message =
        err instanceof Error ? err.message : "Couldn't load ban list.";
      setError(message);
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

  async function submitUnban() {
    if (!unbanTarget) return;
    const target = unbanTarget;
    setBusy(target.userId);
    try {
      const r = await api.unbanMember(roomId, target.userId);
      if (r.ok) {
        toast.success(`Unbanned @${target.username}.`);
        setBans((prev) =>
          prev ? prev.filter((b) => b.userId !== target.userId) : prev,
        );
        return;
      }
      surfaceErr(r.error);
    } finally {
      setBusy(null);
      // Close the dialog on both success and failure so a frustrated user
      // can't double-submit the same unban while a retryable-looking error
      // is on screen — they must reopen to retry.
      setUnbanTarget(null);
    }
  }

  if (!canView) {
    return (
      <div className="text-sm text-muted-foreground">
        Only admins can view the ban list.
      </div>
    );
  }
  // Error state takes precedence over the loading placeholder so a transient
  // listRoomBans failure doesn't leave the tab stuck at "Loading ban list…".
  if (error !== null && bans === null) {
    return (
      <div
        className="space-y-2 text-sm text-muted-foreground"
        data-testid="banned-tab-error"
      >
        <p>Couldn't load ban list.</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void refresh()}
          data-testid="banned-tab-retry"
        >
          Retry
        </Button>
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
    <>
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
                      onClick={() =>
                        setUnbanTarget({ userId: b.userId, username: b.username })
                      }
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
      <UnbanConfirmDialog
        target={unbanTarget}
        roomName={roomName}
        submitting={unbanTarget !== null && busy === unbanTarget.userId}
        onCancel={() => setUnbanTarget(null)}
        onConfirm={submitUnban}
      />
    </>
  );
}

function UnbanConfirmDialog({
  target,
  roomName,
  submitting,
  onCancel,
  onConfirm,
}: {
  target: UnbanTarget;
  roomName?: string;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(o) => (o ? null : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unban @{target?.username ?? ""}</DialogTitle>
          <DialogDescription>
            {roomName
              ? `Unban @${target?.username ?? ""} from #${roomName}? They'll be able to rejoin.`
              : `Unban @${target?.username ?? ""}? They'll be able to rejoin.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={() => void onConfirm()}
            disabled={submitting}
            // UX — unban is a constructive moderation action. Keep the submit
            // as default variant (primary fill) so it reads as "restore
            // access", distinct from the destructive submits in ban/kick.
            data-testid={`unban-confirm-${target?.username ?? ""}`}
          >
            Unban
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
