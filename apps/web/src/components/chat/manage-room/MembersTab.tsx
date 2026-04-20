// REQ-209 — Members tab for ManageRoomModal. Columns: Username | Status |
// Role | Actions. Action visibility is caller-role-gated (plain member: no
// buttons; admin: [Ban]+[Remove] on members; owner: [Make admin] on members
// + [Ban]+[Remove] on members & admins; own row never shows buttons). Ban
// opens a reason dialog; Remove (REQ-203) uses a styled shadcn Dialog confirm
// (KickConfirmDialog) that mirrors the BanReasonDialog pattern —
// shadcn AlertDialog is not in this project.

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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PresencePill } from "@/components/chat/PresencePill";
import { useSession } from "@/lib/auth-client";
import { createChatApi } from "@/lib/socket";
import type {
  ChatAPI,
  ModerationMutationError,
  RoomMemberEntry,
  RoomRole,
} from "@/lib/chat-api";
import { RoleBadge } from "./RoleBadge";

interface MembersTabProps {
  roomId: string;
  roomName: string;
  viewerRole: RoomRole;
}

type BanTarget = { userId: string; username: string } | null;
type KickTarget = { userId: string; username: string } | null;

export function MembersTab({ roomId, roomName, viewerRole }: MembersTabProps) {
  const { data } = useSession();
  const selfId = data?.user?.id;
  const [api] = useState<ChatAPI>(() => createChatApi());
  const [members, setMembers] = useState<RoomMemberEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [banTarget, setBanTarget] = useState<BanTarget>(null);
  const [kickTarget, setKickTarget] = useState<KickTarget>(null);

  async function refresh() {
    try {
      const rows = await api.listRoomMembers(roomId);
      setMembers(rows);
    } catch (err) {
      console.error("[MembersTab] listRoomMembers failed", err);
      toast.error("Couldn't load members.");
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  async function handlePromote(target: RoomMemberEntry) {
    setBusy(target.id);
    const r = await api.promoteAdmin(roomId, target.id);
    setBusy(null);
    if (r.ok) {
      toast.success(`Made @${target.username} an admin.`);
      await refresh();
      return;
    }
    surfaceErr(r.error, "promote");
  }

  async function submitKick() {
    if (!kickTarget) return;
    const target = kickTarget;
    setBusy(target.userId);
    const r = await api.kickMember(roomId, target.userId);
    setBusy(null);
    if (r.ok) {
      toast.success(`Removed @${target.username}.`);
      setKickTarget(null);
      await refresh();
      return;
    }
    surfaceErr(r.error, "kick");
  }

  async function submitBan(reason: string) {
    if (!banTarget) return;
    setBusy(banTarget.userId);
    const r = await api.banMember(roomId, banTarget.userId, reason);
    setBusy(null);
    if (r.ok) {
      toast.success(`Banned @${banTarget.username}.`);
      setBanTarget(null);
      await refresh();
      return;
    }
    surfaceErr(r.error, "ban");
  }

  if (members === null) {
    return <div className="text-sm text-muted-foreground">Loading members…</div>;
  }
  if (members.length === 0) {
    return <div className="text-sm text-muted-foreground">No members.</div>;
  }

  return (
    <>
      <div className="overflow-hidden rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Username</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-left font-medium">Role</th>
              <th className="px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isSelf = selfId === m.id;
              const canPromote =
                viewerRole === "owner" && !isSelf && m.role === "member";
              // Owner can kick members + admins (never owner row).
              // Admin can kick only plain members — spec REQ-203 blocks
              // admin-vs-admin explicitly at 403.
              const canKick =
                !isSelf &&
                m.role !== "owner" &&
                (viewerRole === "owner" ||
                  (viewerRole === "admin" && m.role === "member"));
              const canBan = canKick;
              const busyRow = busy === m.id;
              return (
                <tr key={m.id} className="border-t" data-testid={`member-row-${m.username}`}>
                  <td className="px-3 py-2 align-middle">
                    <div className="flex flex-col">
                      <span className="truncate">{m.displayName}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        @{m.username}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 align-middle">
                    <PresencePill userId={m.id} />
                  </td>
                  <td className="px-3 py-2 align-middle">
                    <RoleBadge role={m.role} />
                  </td>
                  <td className="px-3 py-2 align-middle text-right">
                    <div className="flex justify-end gap-2">
                      {canPromote ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handlePromote(m)}
                          disabled={busyRow}
                          data-testid={`promote-${m.username}`}
                        >
                          Make admin
                        </Button>
                      ) : null}
                      {canBan ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setBanTarget({ userId: m.id, username: m.username })
                          }
                          disabled={busyRow}
                          data-testid={`ban-${m.username}`}
                          // UX(ui-pass P2-8) — Ban and Make admin rendered as
                          // identical secondary outline buttons; Ban is exile,
                          // Make admin is benign. Flag Ban with a destructive-
                          // outline treatment (red text + border at rest, red
                          // fill on hover) so the severity is obvious at a
                          // glance. Make admin stays default outline.
                          className="border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground"
                        >
                          Ban
                        </Button>
                      ) : null}
                      {canKick ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setKickTarget({ userId: m.id, username: m.username })
                          }
                          disabled={busyRow}
                          data-testid={`kick-${m.username}`}
                          // UX(ui-pass remove-ban-consistency) — Ban and
                          // Remove-from-room are adjacent destructive actions
                          // at equal severity. Unify on destructive-outline
                          // (red text + border at rest, red fill on hover) to
                          // dodge the desaturated dark --destructive fill that
                          // reads as "disabled" on the lavender glass card.
                          className="border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground disabled:border-destructive/70 disabled:text-destructive/70 disabled:opacity-100"
                        >
                          Remove from room
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <BanReasonDialog
        target={banTarget}
        roomName={roomName}
        submitting={banTarget !== null && busy === banTarget.userId}
        onCancel={() => setBanTarget(null)}
        onSubmit={submitBan}
      />
      <KickConfirmDialog
        target={kickTarget}
        roomName={roomName}
        submitting={kickTarget !== null && busy === kickTarget.userId}
        onCancel={() => setKickTarget(null)}
        onConfirm={submitKick}
      />
    </>
  );
}

function KickConfirmDialog({
  target,
  roomName,
  submitting,
  onCancel,
  onConfirm,
}: {
  target: KickTarget;
  roomName: string;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(o) => (o ? null : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove @{target?.username ?? ""}</DialogTitle>
          <DialogDescription>
            Remove @{target?.username ?? ""} from #{roomName}? They will be
            removed but can rejoin.
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
            // UX — confirmation-dialog submit stays filled destructive to match
            // BanReasonDialog's submit: the user has already committed by
            // opening this dialog.
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:bg-destructive/70 disabled:text-destructive-foreground disabled:opacity-100"
            data-testid={`kick-confirm-${target?.username ?? ""}`}
          >
            Remove from room
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BanReasonDialog({
  target,
  roomName,
  submitting,
  onCancel,
  onSubmit,
}: {
  target: BanTarget;
  roomName: string;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    setReason("");
  }, [target?.userId]);
  return (
    <Dialog open={target !== null} onOpenChange={(o) => (o ? null : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ban @{target?.username ?? ""}</DialogTitle>
          <DialogDescription>
            Ban this user from #{roomName}. They will be removed and cannot
            rejoin until unbanned.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="ban-reason">Reason (optional, visible to admins)</Label>
          <Textarea
            id="ban-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="Spam, harassment, …"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void onSubmit(reason)}
            disabled={submitting}
            // UX — confirmation-dialog submit stays filled: the user has
            // already committed to the destructive action by opening this
            // dialog, so the final step reads stronger than the in-row
            // Ban/Remove pair (which are destructive-outline to signal
            // "review required" before commit).
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:bg-destructive/70 disabled:text-destructive-foreground disabled:opacity-100"
          >
            Ban user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function surfaceErr(
  err: ModerationMutationError,
  verb: "promote" | "kick" | "ban",
): void {
  switch (err.code) {
    case "not_owner":
      toast.error("Only the room owner can do that.");
      break;
    case "not_admin":
      toast.error("Only owners and admins can moderate this room.");
      break;
    case "already_owner":
      toast.error("That user is the room owner.");
      break;
    case "already_banned":
      toast.error("User is already banned from this room.");
      break;
    case "cannot_kick_owner":
      toast.error("Owners can't be removed.");
      break;
    case "admin_cannot_kick_admin":
      toast.error("Admins can't remove other admins — ask the owner.");
      break;
    case "user_not_member":
      toast.error("That user is no longer in the room.");
      break;
    case "user_not_found":
      toast.error("User not found.");
      break;
    case "room_not_found":
      toast.error("Room no longer exists.");
      break;
    case "rate_limited":
      toast.error("Slow down — try again in a moment.");
      break;
    case "unauthorized":
      toast.error("Please sign in again.");
      break;
    case "network":
      toast.error("Network error — try again.");
      break;
    default:
      toast.error(`Couldn't ${verb} user — try again.`);
  }
}
