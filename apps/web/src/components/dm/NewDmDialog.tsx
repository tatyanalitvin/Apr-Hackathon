// S2 DMs — minimal target picker modal.
//
// Spec punt: the brief accepts a raw User ID input for the MVP. A friends-
// list picker is the obvious follow-up, but the find-or-create endpoint
// is stable either way, so the dialog is swap-in.
//
// Error-code → toast mapping:
//   self_dm          → "Can't DM yourself"
//   dm_not_allowed   → "DM not allowed" (covers not_friends + blocked +
//                      deleted-counterpart — backend collapses them)
//   user_not_found   → "User not found"
//   validation       → "Invalid user ID"
//   unauthorized     → handled by RequireSession redirect elsewhere

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
import { createDm } from "@/lib/dms-api";

export function NewDmDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = userId.trim();
    if (!trimmed) {
      toast.error("Enter a user ID.");
      return;
    }
    setSubmitting(true);
    const r = await createDm(trimmed);
    setSubmitting(false);
    if (r.ok) {
      setOpen(false);
      setUserId("");
      // Tell DmList to refetch so the new row appears without waiting
      // for the next message.new event.
      window.dispatchEvent(new CustomEvent("dm:created"));
      router.push(`/rooms/${r.data.roomId}`);
      return;
    }
    switch (r.error.code) {
      case "self_dm":
        toast.error("Can't DM yourself.");
        break;
      case "dm_not_allowed":
        toast.error("DM not allowed.");
        break;
      case "user_not_found":
        toast.error("User not found.");
        break;
      case "validation":
        toast.error("Invalid user ID.");
        break;
      case "network":
        toast.error("Network error — try again.");
        break;
      default:
        toast.error("Couldn't start DM — try again.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          aria-label="Start a new DM"
        >
          + New
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a direct message</DialogTitle>
          <DialogDescription>
            Enter a user ID. You must be friends and not blocked.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="dm-target-user-id">User ID</Label>
            <Input
              id="dm-target-user-id"
              autoFocus
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="usr_…"
              autoComplete="off"
              disabled={submitting}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Starting…" : "Start DM"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
