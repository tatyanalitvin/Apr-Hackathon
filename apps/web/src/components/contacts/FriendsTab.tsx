// REQ-050 friends list + per-row REQ-059 remove + REQ-073 block.

"use client";

import { useState } from "react";
import { UserMinus, Ban, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  blockUser,
  removeFriend,
  type FriendSummary,
} from "@/lib/friendship-api";

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
      <div className="py-8 text-sm text-muted-foreground">
        No friends yet. Use <span className="font-medium text-foreground">+ Add friend</span> to send your first request.
      </div>
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
      <Avatar className="h-9 w-9">
        <AvatarFallback>{friend.name.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
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
        >
          {busy === "block" ? <Loader2 className="animate-spin" /> : <Ban />}
          Block
        </Button>
      </div>
    </li>
  );
}
