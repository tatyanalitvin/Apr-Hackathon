// REQ-050 friends list + per-row REQ-059 remove + REQ-073 block + Start-DM.
//
// The Message button starts (or opens) a DM with the friend and routes to
// /rooms/<dmId>. Remove is wrapped in a window.confirm (AlertDialog isn't
// installed in this worktree — matches SettingsTab pattern). Block bubbles
// its mutation kind up so the parent refetches both Friends and Blocked.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserMinus, Ban, Loader2, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/avatar/Avatar";
import { Button } from "@/components/ui/button";
import {
  blockUser,
  removeFriend,
  type FriendSummary,
} from "@/lib/friendship-api";
import { createDm, type DmError } from "@/lib/dms-api";
import { refreshMyBlocks } from "@/lib/use-my-blocks";
import { BlossomEmptyState } from "@/components/empty/BlossomEmptyState";

export type FriendsTabMutationKind = "remove" | "block";

interface FriendsTabProps {
  friends: FriendSummary[];
  loading: boolean;
  // Second arg is optional so existing call sites that only care about the
  // "refresh everything" signal keep working. ContactsClient passes the kind
  // through so it can additionally refetch the Blocked list after a block.
  onMutate: (kind?: FriendsTabMutationKind) => void;
}

export function FriendsTab({ friends, loading, onMutate }: FriendsTabProps) {
  if (loading && friends.length === 0) {
    return <div className="py-8 text-sm text-muted-foreground">Loading friends…</div>;
  }
  if (friends.length === 0) {
    return (
      <BlossomEmptyState tagline="No friends yet. Send an invitation to start.">
        <p className="text-xs" style={{ color: "var(--text-lo)" }}>
          Use the <span className="font-medium" style={{ color: "var(--text-hi)" }}>+ Add friend</span> button above.
        </p>
      </BlossomEmptyState>
    );
  }
  return (
    <ul className="flex flex-col gap-1" aria-label="Friends">
      {friends.map((f) => (
        <FriendRow key={f.userId} friend={f} onMutate={onMutate} />
      ))}
    </ul>
  );
}

// Narrow DM start-error shape onto user-facing toasts. Kept local to this
// component since it's the only Start-DM call site in the contacts surface.
function toastForDmStartError(error: DmError, username: string): void {
  switch (error.code) {
    case "dm_not_allowed":
      toast.error(`You can't DM @${username} right now — check your friend status.`);
      return;
    case "user_not_found":
      toast.error("User not found.");
      return;
    case "self_dm":
      toast.error("You can't DM yourself.");
      return;
    case "rate_limited":
      toast.error("Too many DM requests — try again in a moment.");
      return;
    case "unauthorized":
      toast.error("You need to sign in first.");
      return;
    case "network":
      toast.error("Network error — check your connection.");
      return;
    default:
      toast.error("Couldn't start DM — try again.");
  }
}

function FriendRow({
  friend,
  onMutate,
}: {
  friend: FriendSummary;
  onMutate: (kind?: FriendsTabMutationKind) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"message" | "remove" | "block" | null>(null);

  const handleMessage = async () => {
    setBusy("message");
    const r = await createDm(friend.userId);
    if (r.ok) {
      // Keep `busy` set — the navigation unmounts this component, and we
      // don't want the button to re-enable briefly before the route swap.
      window.dispatchEvent(new CustomEvent("dm:created"));
      router.push(`/rooms/${r.data.roomId}`);
      return;
    }
    setBusy(null);
    toastForDmStartError(r.error, friend.username);
  };

  const handleRemove = async () => {
    const confirmed = window.confirm(
      `Remove @${friend.username} from your friends? You'll lose your DM thread context.`,
    );
    if (!confirmed) return;
    setBusy("remove");
    const r = await removeFriend(friend.userId);
    setBusy(null);
    if (r.ok) {
      toast.success(`Removed @${friend.username}`);
      onMutate("remove");
    } else {
      toast.error("Couldn't remove — try again.");
    }
  };

  const handleBlock = async () => {
    // Symmetric block: tears down DM, friendship, and invitations in one
    // shot with no undo. Gate behind confirm so a misclick doesn't nuke
    // the relationship (mirrors handleRemove's confirm flow).
    const confirmed = window.confirm(
      `Block @${friend.username}? This removes the friendship, ends your DM thread, and cancels any pending invitations — there's no undo.`,
    );
    if (!confirmed) return;
    setBusy("block");
    const r = await blockUser(friend.userId);
    setBusy(null);
    if (r.ok) {
      toast.success(`Blocked @${friend.username}`);
      void refreshMyBlocks();
      onMutate("block");
    } else {
      toast.error("Couldn't block — try again.");
    }
  };

  return (
    <li className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2 transition-colors hover:bg-accent/40">
      <Avatar userId={friend.userId} name={friend.name} size={40} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm font-medium">{friend.name}</div>
        <div className="truncate text-xs text-muted-foreground">@{friend.username}</div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          size="sm"
          variant="default"
          onClick={handleMessage}
          disabled={busy !== null}
          aria-label={`Message ${friend.username}`}
        >
          {busy === "message" ? <Loader2 className="animate-spin" /> : <MessageSquare />}
          Message
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleRemove}
          disabled={busy !== null}
          aria-label={`Remove ${friend.username}`}
        >
          {busy === "remove" ? <Loader2 className="animate-spin" /> : <UserMinus />}
          Remove
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={handleBlock}
          disabled={busy !== null}
          aria-label={`Block ${friend.username}`}
          // UX(ui-pass P0-4) — Block CTA desaturates on the dark contacts
          // list; pin full --destructive fill at rest + disabled so the
          // action stays legible next to the neutral Remove button.
          className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:bg-destructive/70 disabled:text-destructive-foreground disabled:opacity-100"
        >
          {busy === "block" ? <Loader2 className="animate-spin" /> : <Ban />}
          Block
        </Button>
      </div>
    </li>
  );
}
