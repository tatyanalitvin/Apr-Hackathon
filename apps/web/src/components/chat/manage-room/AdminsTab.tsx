// REQ-210 — Admins tab. Lists owner + current admins. Owner row is fixed
// ("Owner (cannot lose admin rights)"); admin rows show [Remove admin] to the
// owner viewer only (admin viewer gets no buttons here — the server gate at
// REQ-202 owner-only is authoritative). Demote opens a styled shadcn Dialog
// confirm (DemoteConfirmDialog) — AlertDialog is not in this project.

"use client";

import { useEffect, useState } from "react";
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
import { createChatApi } from "@/lib/socket";
import type {
  ChatAPI,
  ModerationMutationError,
  RoomMemberEntry,
  RoomRole,
} from "@/lib/chat-api";
import { RoleBadge } from "./RoleBadge";

interface AdminsTabProps {
  roomId: string;
  viewerRole: RoomRole;
}

type DemoteTarget = { userId: string; username: string } | null;

export function AdminsTab({ roomId, viewerRole }: AdminsTabProps) {
  const [api] = useState<ChatAPI>(() => createChatApi());
  const [members, setMembers] = useState<RoomMemberEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [demoteTarget, setDemoteTarget] = useState<DemoteTarget>(null);

  async function refresh() {
    try {
      const rows = await api.listRoomMembers(roomId);
      setMembers(rows);
    } catch (err) {
      console.error("[AdminsTab] listRoomMembers failed", err);
      toast.error("Couldn't load admins.");
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  async function submitDemote() {
    if (!demoteTarget) return;
    const target = demoteTarget;
    setBusy(target.userId);
    const r = await api.demoteAdmin(roomId, target.userId);
    setBusy(null);
    if (r.ok) {
      toast.success(`@${target.username} is no longer an admin.`);
      setDemoteTarget(null);
      await refresh();
      return;
    }
    surfaceErr(r.error);
  }

  if (members === null) {
    return <div className="text-sm text-muted-foreground">Loading admins…</div>;
  }

  const staff = members.filter((m) => m.role === "owner" || m.role === "admin");
  if (staff.length === 0) {
    return <div className="text-sm text-muted-foreground">No admins yet.</div>;
  }

  return (
    <div className="overflow-hidden rounded border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Username</th>
            <th className="px-3 py-2 text-left font-medium">Role</th>
            <th className="px-3 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {staff.map((m) => {
            const isOwner = m.role === "owner";
            const canDemote = !isOwner && viewerRole === "owner";
            const busyRow = busy === m.id;
            return (
              <tr key={m.id} className="border-t" data-testid={`admin-row-${m.username}`}>
                <td className="px-3 py-2 align-middle">
                  <div className="flex flex-col">
                    <span className="truncate">{m.displayName}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      @{m.username}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 align-middle">
                  {isOwner ? (
                    <div className="flex items-center gap-2">
                      <RoleBadge role="owner" />
                      <span className="text-xs text-muted-foreground">
                        (cannot lose admin rights)
                      </span>
                    </div>
                  ) : (
                    <RoleBadge role="admin" />
                  )}
                </td>
                <td className="px-3 py-2 align-middle text-right">
                  {canDemote ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setDemoteTarget({ userId: m.id, username: m.username })
                      }
                      disabled={busyRow}
                      data-testid={`demote-${m.username}`}
                    >
                      Remove admin
                    </Button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <DemoteConfirmDialog
        target={demoteTarget}
        submitting={demoteTarget !== null && busy === demoteTarget.userId}
        onCancel={() => setDemoteTarget(null)}
        onConfirm={submitDemote}
      />
    </div>
  );
}

function DemoteConfirmDialog({
  target,
  submitting,
  onCancel,
  onConfirm,
}: {
  target: DemoteTarget;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(o) => (o ? null : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove admin rights</DialogTitle>
          <DialogDescription>
            Demote @{target?.username ?? ""} to member?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void onConfirm()}
            disabled={submitting}
            // UX — demote is a reversible privilege removal but still a
            // deliberate moderation action; keep the filled destructive
            // treatment used by the other confirm dialogs for consistency.
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:bg-destructive/70 disabled:text-destructive-foreground disabled:opacity-100"
            data-testid={`demote-confirm-${target?.username ?? ""}`}
          >
            Remove admin
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function surfaceErr(err: ModerationMutationError): void {
  switch (err.code) {
    case "cannot_demote_owner":
      toast.error("Owners can't lose admin rights.");
      break;
    case "not_owner":
      toast.error("Only the room owner can demote admins.");
      break;
    case "user_not_member":
      toast.error("User is no longer in the room.");
      break;
    case "room_not_found":
      toast.error("Room no longer exists.");
      break;
    case "unauthorized":
      toast.error("Please sign in again.");
      break;
    case "rate_limited":
      toast.error("Slow down — try again in a moment.");
      break;
    case "network":
      toast.error("Network error — try again.");
      break;
    default:
      toast.error("Couldn't remove admin rights — try again.");
  }
}
