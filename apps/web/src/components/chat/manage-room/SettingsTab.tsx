// REQ-022/REQ-087/REQ-088 (owner) + REQ-089 (delete) + REQ-027 (leave).
// Owners edit name, description, and visibility in one form; members see the
// leave affordance. The single Save button diffs against the initial state so
// the PATCH payload only carries changed fields — keeping the audit log
// readable and avoiding REQ-087's rename rate-limit on no-op submissions.

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { createChatApi } from "@/lib/socket";
import type { RoomMutationError, UpdateRoomInput } from "@/lib/chat-api";

// REQ-210 widens Role to cover promoted admins; admin viewers get the leave
// affordance (same as member) — rename/delete stays owner-only per REQ-087/089.
type Role = "owner" | "admin" | "member";
type Visibility = "public" | "private";

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
  const [description, setDescription] = useState("");
  const [initialDescription, setInitialDescription] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [initialVisibility, setInitialVisibility] = useState<Visibility>("public");
  const [submitting, setSubmitting] = useState<null | "save" | "delete" | "leave">(null);
  const [api] = useState(() => createChatApi());

  useEffect(() => {
    if (open) setName(roomName);
  }, [open, roomName]);

  // Owners need the current description + visibility to diff against on save.
  // /rooms/me already carries both after REQ-022 widening, so we lean on the
  // existing endpoint instead of a new /rooms/:id fetch.
  useEffect(() => {
    if (!open || role !== "owner") return;
    let cancelled = false;
    void (async () => {
      try {
        const rooms = await api.listMyRooms();
        if (cancelled) return;
        const row = rooms.find((r) => r.id === roomId);
        if (!row) return;
        const desc = row.description ?? null;
        setInitialDescription(desc);
        setDescription(desc ?? "");
        setInitialVisibility(row.visibility);
        setVisibility(row.visibility);
      } catch {
        // Non-fatal — save still diffs against the defaults, which is a
        // no-op unless the user types something.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, open, role, roomId]);

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Enter a room name.");
      return;
    }

    const payload: UpdateRoomInput = {};
    if (trimmedName !== roomName) payload.name = trimmedName;

    const trimmedDesc = description.trim();
    const nextDescription = trimmedDesc.length > 0 ? trimmedDesc : null;
    if (nextDescription !== initialDescription) {
      payload.description = nextDescription;
    }

    if (visibility !== initialVisibility) payload.visibility = visibility;

    if (Object.keys(payload).length === 0) {
      onClose();
      return;
    }

    setSubmitting("save");
    const r = await api.updateRoom(roomId, payload);
    setSubmitting(null);
    if (r.ok) {
      toast.success(`Saved changes to #${r.data.name}.`);
      setInitialDescription(r.data.description);
      setInitialVisibility(r.data.visibility);
      if (payload.name) onRenamed?.(r.data.name);
      onClose();
      return;
    }
    handleMutationError(r.error, "save");
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
        <form onSubmit={handleSave} className="space-y-3">
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

          <div className="space-y-1.5">
            <Label htmlFor="room-description">
              Description <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="room-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this room for?"
              rows={3}
              maxLength={500}
              disabled={submitting !== null}
            />
          </div>

          <fieldset
            className="space-y-2"
            aria-label="Room visibility"
            disabled={submitting !== null}
          >
            <legend className="text-sm font-medium">Visibility</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="settings-visibility"
                value="public"
                checked={visibility === "public"}
                onChange={() => setVisibility("public")}
                className="mt-1"
              />
              <span>
                <span className="font-medium">Public</span>
                <span className="block text-xs text-muted-foreground">
                  Appears in the catalog at /rooms/browse.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="settings-visibility"
                value="private"
                checked={visibility === "private"}
                onChange={() => setVisibility("private")}
                className="mt-1"
              />
              <span>
                <span className="font-medium">Private</span>
                <span className="block text-xs text-muted-foreground">
                  Invite-only. Hidden from the catalog.
                </span>
              </span>
            </label>
          </fieldset>

          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={submitting !== null}
              // UX(ui-pass P1-8) — primary submit ghosts out via opacity-50
              // while the PATCH is in flight, so users think the button has
              // vanished. Hold the primary fill + light text at a softened
              // tint instead to keep the action visible.
              className="disabled:bg-primary/70 disabled:text-primary-foreground disabled:opacity-100"
            >
              {submitting === "save" ? "Saving…" : "Save"}
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
            // UX(ui-pass P0-4) — danger-zone Delete button washes out on the
            // dark glass panel; pin saturation at rest + disabled.
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:bg-destructive/70 disabled:text-destructive-foreground disabled:opacity-100"
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
        // UX(ui-pass P0-4) — member/admin Leave button fades into the dark
        // panel; hold --destructive saturation so the exit is visible.
        className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:bg-destructive/70 disabled:text-destructive-foreground disabled:opacity-100"
      >
        {submitting === "leave" ? "Leaving…" : "Leave room"}
      </Button>
    </div>
  );
}

function handleMutationError(
  err: RoomMutationError,
  verb: "save" | "delete" | "leave",
): void {
  switch (err.code) {
    case "validation":
      toast.error("Name must be 3–64 chars of letters, numbers, space, _ or -; description must be ≤500 chars.");
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
