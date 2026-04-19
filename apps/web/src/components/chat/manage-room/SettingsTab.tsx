// REQ-087 (rename) + REQ-089 (delete) + REQ-027 (leave) — moved verbatim from
// the former RoomSettingsModal. Body-only; the Dialog shell lives in
// ManageRoomModal. Owners see rename + delete; members see leave.

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { createChatApi } from "@/lib/socket";
import type { RoomMutationError } from "@/lib/chat-api";

type Role = "owner" | "member";

interface SettingsTabProps {
  roomId: string;
  roomName: string;
  role: Role;
  open: boolean;
  onClose: () => void;
  onRenamed?: (nextName: string) => void;
  onLeftOrDeleted?: () => void;
}

export function SettingsTab({
  roomId,
  roomName,
  role,
  open,
  onClose,
  onRenamed,
  onLeftOrDeleted,
}: SettingsTabProps) {
  const router = useRouter();
  const [name, setName] = useState(roomName);
  const [submitting, setSubmitting] = useState<null | "rename" | "delete" | "leave">(null);
  const [api] = useState(() => createChatApi());

  useEffect(() => {
    if (open) setName(roomName);
  }, [open, roomName]);

  async function handleRename(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Enter a room name.");
      return;
    }
    if (trimmed === roomName) {
      onClose();
      return;
    }
    setSubmitting("rename");
    const r = await api.updateRoom(roomId, { name: trimmed });
    setSubmitting(null);
    if (r.ok) {
      toast.success(`Room renamed to ${r.data.name}.`);
      onRenamed?.(r.data.name);
      onClose();
      return;
    }
    handleMutationError(r.error, "rename");
  }

  async function handleDelete() {
    const confirmed =
      typeof window !== "undefined" &&
      window.confirm(
        `Delete #${roomName}? This removes the room for everyone and cannot be undone.`,
      );
    if (!confirmed) return;
    setSubmitting("delete");
    const r = await api.deleteRoom(roomId);
    setSubmitting(null);
    if (r.ok) {
      toast.success(`Deleted #${roomName}.`);
      onClose();
      onLeftOrDeleted?.();
      router.push("/rooms");
      return;
    }
    handleMutationError(r.error, "delete");
  }

  async function handleLeave() {
    const confirmed =
      typeof window !== "undefined" &&
      window.confirm(`Leave #${roomName}?`);
    if (!confirmed) return;
    setSubmitting("leave");
    const r = await api.leaveRoom(roomId);
    setSubmitting(null);
    if (r.ok) {
      toast.success(`Left #${roomName}.`);
      onClose();
      onLeftOrDeleted?.();
      router.push("/rooms");
      return;
    }
    handleMutationError(r.error, "leave");
  }

  if (role === "owner") {
    return (
      <div className="space-y-6">
        <form onSubmit={handleRename} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="room-rename-name">Room name</Label>
            <Input
              id="room-rename-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              maxLength={64}
              disabled={submitting !== null}
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={submitting !== null}>
              {submitting === "rename" ? "Saving…" : "Rename"}
            </Button>
          </div>
        </form>

        <div className="border-t pt-4">
          <div className="text-sm font-medium text-destructive mb-1">
            Danger zone
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Deleting removes messages and memberships for everyone.
          </p>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => void handleDelete()}
            disabled={submitting !== null}
          >
            {submitting === "delete" ? "Deleting…" : "Delete room"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-end">
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => void handleLeave()}
        disabled={submitting !== null}
      >
        {submitting === "leave" ? "Leaving…" : "Leave room"}
      </Button>
    </div>
  );
}

function handleMutationError(
  err: RoomMutationError,
  verb: "rename" | "delete" | "leave",
): void {
  switch (err.code) {
    case "validation":
      toast.error("Name must be 3–64 chars of letters, numbers, space, _ or -.");
      break;
    case "name_taken":
      toast.error("That room name is taken.");
      break;
    case "rate_limited":
      toast.error("Slow down — too many changes recently.");
      break;
    case "not_room_owner":
      toast.error("Only the room owner can do that.");
      break;
    case "room_not_found":
      toast.error("Room no longer exists.");
      break;
    case "forbidden":
      toast.error(err.message === "owner_cannot_leave"
        ? "Owners can't leave — delete the room instead."
        : "Action not allowed.");
      break;
    case "unauthorized":
      toast.error("Please sign in again.");
      break;
    case "network":
      toast.error("Network error — try again.");
      break;
    default:
      toast.error(`Couldn't ${verb} room — try again.`);
  }
}
