// REQ-210 — Admins tab. Lists owner + current admins. Owner row is fixed
// ("Owner (cannot lose admin rights)"); admin rows show [Remove admin] to the
// owner viewer only (admin viewer gets no buttons here — the server gate at
// REQ-202 owner-only is authoritative). Demote uses window.confirm.

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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

export function AdminsTab({ roomId, viewerRole }: AdminsTabProps) {
  const [api] = useState<ChatAPI>(() => createChatApi());
  const [members, setMembers] = useState<RoomMemberEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  async function handleDemote(target: RoomMemberEntry) {
    const confirmed =
      typeof window !== "undefined" &&
      window.confirm(`Remove admin rights from @${target.username}?`);
    if (!confirmed) return;
    setBusy(target.id);
    const r = await api.demoteAdmin(roomId, target.id);
    setBusy(null);
    if (r.ok) {
      toast.success(`@${target.username} is no longer an admin.`);
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
                      onClick={() => void handleDemote(m)}
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
    </div>
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
