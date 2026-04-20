// REQ-050 friends list + per-row REQ-059 remove + REQ-073 block.

"use client";

import { useState } from "react";
import { UserMinus, Ban, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/avatar/Avatar";
import { Button } from "@/components/ui/button";
import {
  blockUser,
  removeFriend,
  type FriendSummary,
} from "@/lib/friendship-api";
import { BlossomEmptyState } from "@/components/empty/BlossomEmptyState";

interface FriendsTabProps {
  friends: FriendSummary[];
  loading: boolean;
  onMutate: () => void;
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

function FriendRow({
  friend,
  onMutate,
}: {
  friend: FriendSummary;
  onMutate: () => void;
}) {
  const [busy, setBusy] = useState<"remove" | "block" | null>(null);

  const handleRemove = async () => {
    setBusy("remove");
    const r = await removeFriend(friend.userId);
    setBusy(null);
    if (r.ok) {
      toast.success(`Removed @${friend.username}`);
      onMutate();
    } else {
      toast.error("Couldn't remove — try again.");
    }
  };

  const handleBlock = async () => {
    setBusy("block");
    const r = await blockUser(friend.userId);
    setBusy(null);
    if (r.ok) {
      toast.success(`Blocked @${friend.username}`);
      onMutate();
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
