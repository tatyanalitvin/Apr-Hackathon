// REQ-087 (rename) + REQ-089 (delete) + REQ-027 (leave) — room settings
// drawer, surfaced by the gear icon in the room header.
//
// Role-gated controls per the brief §1c:
//   - owner  → Rename + Delete   (never Leave; owners leave by deleting)
//   - member → Leave             (no Rename/Delete surface)
//
// Skipped entirely for kind === "dm" rooms — DM mutations flow through
// the DM-specific backend routes, not this handler. The parent (RoomClient)
// decides whether to render the gear at all.

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createChatApi } from "@/lib/socket";
import type { RoomMutationError } from "@/lib/chat-api";

type Role = "owner" | "member";

interface RoomSettingsModalProps {
  roomId: string;
  roomName: string;
  role: Role;
  onRenamed?: (nextName: string) => void;
  onLeftOrDeleted?: () => void;
}

export function RoomSettingsModal({
  roomId,
  roomName,
  role,
  onRenamed,
  onLeftOrDeleted,
}: RoomSettingsModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(roomName);
  const [submitting, setSubmitting] = useState<null | "rename" | "delete" | "leave">(null);
  const [api] = useState(() => createChatApi());

  // Reset the name field to the current room name whenever we (re)open so
  // a cancelled rename doesn't leak the edited string back the next time.
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
      setOpen(false);
      return;
    }
    setSubmitting("rename");
    const r = await api.updateRoom(roomId, { name: trimmed });
    setSubmitting(null);
    if (r.ok) {
      toast.success(`Room renamed to ${r.data.name}.`);
      onRenamed?.(r.data.name);
      setOpen(false);
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
      setOpen(false);
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
      setOpen(false);
      onLeftOrDeleted?.();
      router.push("/rooms");
      return;
    }
    handleMutationError(r.error, "leave");
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label="Room settings"
        >
          <Settings2 className="h-4 w-4" aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>#{roomName}</DialogTitle>
          <DialogDescription>
            {role === "owner"
              ? "You own this room — rename or delete it for everyone."
              : "Leave this room. You can rejoin later from Browse."}
          </DialogDescription>
        </DialogHeader>

        {role === "owner" ? (
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
                <Button
                  type="submit"
                  size="sm"
                  disabled={submitting !== null}
                >
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
        ) : (
          <DialogFooter>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => void handleLeave()}
              disabled={submitting !== null}
            >
              {submitting === "leave" ? "Leaving…" : "Leave room"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
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
