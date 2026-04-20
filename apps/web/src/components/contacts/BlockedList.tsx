// REQ-074 — blocked list + per-row unblock. Unblock is one-way (DELETE
// /users/:id/ban) and does NOT restore friendship (spec R18). Fetched lazily
// by the parent only when the Blocked tab is opened.

"use client";

import { useState } from "react";
import { Ban, Loader2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/avatar/Avatar";
import { Button } from "@/components/ui/button";
import { unblockUser, type BlockedUser } from "@/lib/friendship-api";

interface BlockedListProps {
  blocked: BlockedUser[];
  loading: boolean;
  onMutate: () => void;
}

export function BlockedList({ blocked, loading, onMutate }: BlockedListProps) {
  if (loading && blocked.length === 0) {
    return <div className="py-8 text-sm text-muted-foreground">Loading blocked users…</div>;
  }
  if (blocked.length === 0) {
    return (
      <div className="py-8 text-sm text-muted-foreground">
        <Ban className="inline-block h-4 w-4 align-text-bottom" aria-hidden />{" "}
        You haven&apos;t blocked anyone.
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1" aria-label="Blocked users">
      {blocked.map((b) => (
        <BlockedRow key={b.userId} user={b} onMutate={onMutate} />
      ))}
    </ul>
  );
}

function BlockedRow({ user, onMutate }: { user: BlockedUser; onMutate: () => void }) {
  const [busy, setBusy] = useState(false);

  const handleUnblock = async () => {
    setBusy(true);
    const r = await unblockUser(user.userId);
    setBusy(false);
    if (r.ok) {
      // REQ-074: friendship is NOT auto-restored; surface that so the user
      // doesn't expect the old friendship back.
      toast.success(`Unblocked @${user.username}. You're not friends again yet — send a new request if you want.`);
      onMutate();
    } else {
      toast.error("Couldn't unblock — try again.");
    }
  };

  return (
    <li className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2">
      <Avatar userId={user.userId} name={user.name} size={40} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm font-medium">{user.name}</div>
        <div className="truncate text-xs text-muted-foreground">@{user.username}</div>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={handleUnblock}
        disabled={busy}
        aria-label={`Unblock ${user.username}`}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Undo2 />}
        Unblock
      </Button>
    </li>
  );
}
