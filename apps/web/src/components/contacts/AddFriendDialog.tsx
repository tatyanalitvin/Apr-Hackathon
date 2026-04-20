// REQ-051 — "+ Add friend" dialog. Username-only input; routes through the
// toUsername branch of sendFriendRequestSchema. Sentinel success (REQ-053) is
// invisible by design: a 201 always shows the same "Request sent" toast.

"use client";

import { useState } from "react";
import { UserPlus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { sendFriendRequest } from "@/lib/friendship-api";
import { toastForSendError } from "./AddFriendButton";

const USERNAME_RE = /^[a-zA-Z0-9_]+$/;

export function AddFriendDialog({ onSent }: { onSent?: () => void }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setUsername("");
    setMessage("");
    setError(null);
  };

  const validate = (value: string): string | null => {
    if (value.length < 3 || value.length > 32) {
      return "Username must be 3–32 characters.";
    }
    if (!USERNAME_RE.test(value)) {
      return "Letters, digits, and underscore only.";
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = username.trim();
    const validationError = validate(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    const r = await sendFriendRequest({
      toUsername: trimmed,
      ...(message.trim() ? { message: message.trim() } : {}),
    });
    setBusy(false);
    if (r.ok) {
      // REQ-053: identical toast for real-insert and sentinel branches.
      toast.success(`Friend request sent to @${trimmed}`);
      onSent?.();
      setOpen(false);
      reset();
      return;
    }
    toastForSendError(r.error);
    // Keep the dialog open on validation errors so the user can correct; close
    // on 404/429/duplicate branches because re-submitting won't help.
    if (r.error.code === "validation" || r.error.code === "user_not_found") {
      setError(
        r.error.code === "user_not_found"
          ? "No user with that username."
          : "Check the username format.",
      );
    } else {
      setOpen(false);
      reset();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="default">
          <UserPlus /> Add friend
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a friend</DialogTitle>
          <DialogDescription>
            Send a friend request by username. They&apos;ll see it in their Incoming tab.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="af-username">Username</Label>
            <Input
              id="af-username"
              placeholder="e.g. bob"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                if (error) setError(null);
              }}
              autoFocus
              autoComplete="off"
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={error ? "af-username-err" : undefined}
              disabled={busy}
            />
            {error ? (
              <p id="af-username-err" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="af-message" className="flex items-center justify-between">
              <span>Message</span>
              <span className="text-xs text-muted-foreground">optional · max 500</span>
            </Label>
            <Textarea
              id="af-message"
              placeholder="Hey, we worked together on the herders jam"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={500}
              rows={3}
              disabled={busy}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                reset();
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || username.trim().length === 0}
              className="disabled:bg-primary/70 disabled:text-primary-foreground disabled:opacity-100"
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              Send request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
