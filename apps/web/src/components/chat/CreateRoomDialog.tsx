// REQ-023 + REQ-088 — client-side "+ New room" dialog. Posts to /api/v1/rooms
// with a trimmed, NFC-normalised name and a visibility selector (default
// public). On success navigates into the created room. Error-code → toast
// mapping mirrors NewDmDialog's pattern.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { createChatApi } from "@/lib/socket";

interface CreateRoomDialogProps {
  onCreated?: () => void;
}

type Visibility = "public" | "private";

export function CreateRoomDialog({ onCreated }: CreateRoomDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [submitting, setSubmitting] = useState(false);
  // Field-level validation errors from the backend zod flatten() response.
  // Populated when the mutation returns `{code:"validation", fieldErrors}`
  // so we can render inline messages under the Name / Description inputs.
  const [nameError, setNameError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [api] = useState(() => createChatApi());

  function clearFieldErrors() {
    setNameError(null);
    setDescriptionError(null);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    clearFieldErrors();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Enter a room name.");
      return;
    }
    const trimmedDesc = description.trim();
    setSubmitting(true);
    const r = await api.createRoom({
      name: trimmed,
      visibility,
      ...(trimmedDesc ? { description: trimmedDesc } : {}),
    });
    setSubmitting(false);
    if (r.ok) {
      setOpen(false);
      setName("");
      setDescription("");
      setVisibility("public");
      clearFieldErrors();
      onCreated?.();
      router.push(`/rooms/${r.data.id}`);
      return;
    }
    switch (r.error.code) {
      case "validation": {
        const fe = r.error.fieldErrors;
        const nameMsg = fe?.name?.[0];
        const descMsg = fe?.description?.[0];
        if (nameMsg || descMsg) {
          if (nameMsg) {
            setNameError(nameMsg);
            toast.error(nameMsg);
          }
          if (descMsg) {
            setDescriptionError(descMsg);
            if (!nameMsg) toast.error(descMsg);
          }
        } else {
          toast.error("Letters, numbers, spaces, _, -. 3–64 characters.");
        }
        break;
      }
      case "name_taken":
        toast.error("That room name is taken.");
        break;
      case "rate_limited":
        toast.error("Slow down — too many rooms created recently.");
        break;
      case "unauthorized":
        toast.error("Please sign in again.");
        break;
      case "network":
        toast.error("Network error — try again.");
        break;
      default:
        toast.error("Couldn't create room — try again.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          aria-label="Create a new room"
        >
          + New room
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new room</DialogTitle>
          <DialogDescription>
            Public rooms appear in the catalog at /rooms/browse. Private rooms
            are invite-only — members join via a room invitation.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="create-room-name">Name</Label>
            <Input
              id="create-room-name"
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(null);
              }}
              placeholder="book-club"
              autoComplete="off"
              disabled={submitting}
              maxLength={64}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? "create-room-name-error" : undefined}
            />
            {nameError ? (
              <p
                id="create-room-name-error"
                className="text-sm text-destructive"
                role="alert"
              >
                {nameError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Letters, numbers, spaces, _, -. 3–64 characters.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="create-room-description">
              Description <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="create-room-description"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                if (descriptionError) setDescriptionError(null);
              }}
              placeholder="What's this room for?"
              rows={3}
              maxLength={500}
              disabled={submitting}
              aria-invalid={descriptionError ? true : undefined}
              aria-describedby={
                descriptionError ? "create-room-description-error" : undefined
              }
            />
            {descriptionError ? (
              <p
                id="create-room-description-error"
                className="text-sm text-destructive"
                role="alert"
              >
                {descriptionError}
              </p>
            ) : null}
          </div>

          <fieldset
            className="space-y-2"
            aria-label="Room visibility"
            disabled={submitting}
          >
            <legend className="text-sm font-medium">Visibility</legend>
            <RadioGroup
              value={visibility}
              onValueChange={(v) => setVisibility(v as Visibility)}
              aria-label="Room visibility"
            >
              <label
                htmlFor="create-room-visibility-public"
                className="flex items-start gap-2 text-sm"
              >
                <RadioGroupItem
                  id="create-room-visibility-public"
                  value="public"
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">Public</span>
                  <span className="block text-xs text-muted-foreground">
                    Anyone can browse and join.
                  </span>
                </span>
              </label>
              <label
                htmlFor="create-room-visibility-private"
                className="flex items-start gap-2 text-sm"
              >
                <RadioGroupItem
                  id="create-room-visibility-private"
                  value="private"
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">Private</span>
                  <span className="block text-xs text-muted-foreground">
                    Invite-only. Owners and admins can send invitations.
                  </span>
                </span>
              </label>
            </RadioGroup>
          </fieldset>

          <DialogFooter>
            <Button
              type="submit"
              disabled={submitting || name.trim().length === 0}
              className="disabled:bg-primary/70 disabled:text-primary-foreground disabled:opacity-100"
            >
              {submitting ? "Creating…" : "Create room"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
