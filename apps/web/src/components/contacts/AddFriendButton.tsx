// REQ-052 — reusable "Add friend" button used both in MemberList (inline, by
// userId) and as the ContactsPage dialog trigger (handled separately via
// AddFriendDialog's own DialogTrigger).
//
// Design choice: light-duty approach — the button always fires POST and reacts
// to 409/429 via toast. Cross-referencing /friends + /friends/requests to
// pre-compute "Friends"/"Pending" badges would need lifted state; we prefer
// the simpler path (brief §3 allows either). Parent can still gate by passing
// `disabledReason` when it knows the state (e.g. Friends tab row).

"use client";

import { useState } from "react";
import { UserPlus, Check, Hourglass, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { sendFriendRequest } from "@/lib/friendship-api";

export type AddFriendButtonState = "idle" | "friends" | "pending" | "blocked-self";

export interface AddFriendButtonProps {
  targetUserId: string;
  targetUsername: string;
  /**
   * Optional pre-known state. When supplied the button renders a disabled
   * affordance ("Friends", "Pending") and skips the POST.
   */
  state?: AddFriendButtonState;
  size?: "sm" | "default";
  onSent?: () => void;
}

export function AddFriendButton({
  targetUserId,
  targetUsername,
  state = "idle",
  size = "sm",
  onSent,
}: AddFriendButtonProps) {
  const [busy, setBusy] = useState(false);

  if (state === "blocked-self") {
    // REQ-053 — UI does not render the affordance for users the caller blocked.
    return null;
  }
  if (state === "friends") {
    return (
      <Button size={size} variant="secondary" disabled aria-label="Already friends">
        <Check /> Friends
      </Button>
    );
  }
  if (state === "pending") {
    return (
      <Button size={size} variant="secondary" disabled aria-label="Request pending">
        <Hourglass /> Pending
      </Button>
    );
  }

  const handleClick = async () => {
    setBusy(true);
    const r = await sendFriendRequest({ toUserId: targetUserId });
    setBusy(false);
    if (r.ok) {
      // REQ-053: identical toast for real insert and sentinel. Never cross-
      // reference the outgoing list to detect a block.
      toast.success(`Friend request sent to @${targetUsername}`);
      onSent?.();
      return;
    }
    toastForSendError(r.error);
  };

  return (
    <Button
      size={size}
      variant="outline"
      onClick={handleClick}
      disabled={busy}
      aria-label={`Add ${targetUsername} as friend`}
    >
      {busy ? <Loader2 className="animate-spin" /> : <UserPlus />}
      Add friend
    </Button>
  );
}

export function toastForSendError(
  error: { code: string; retryAfterSec?: number; status?: number },
): void {
  switch (error.code) {
    case "already_friends":
      toast.info("You're already friends with this user.");
      return;
    case "request_declined":
      toast.warning("Your previous request was declined — they need to start the next one.");
      return;
    case "user_not_found":
      toast.error("User not found.");
      return;
    case "self_request":
      toast.error("You can't send a friend request to yourself.");
      return;
    case "rate_limited": {
      const mins = error.retryAfterSec
        ? Math.max(1, Math.ceil(error.retryAfterSec / 60))
        : null;
      toast.error(
        mins
          ? `Too many friend requests — try again in ~${mins} min.`
          : "Too many friend requests — try again later.",
      );
      return;
    }
    case "validation":
      toast.error("Username looks wrong — 3–32 chars, letters/digits/_ only.");
      return;
    case "unauthorized":
      toast.error("You need to sign in first.");
      return;
    case "network":
      toast.error("Network error — check your connection.");
      return;
    default:
      toast.error("Something went wrong. Please try again.");
  }
}
