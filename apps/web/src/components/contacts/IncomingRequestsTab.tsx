// REQ-057 three-button row: Accept / Decline / Block. Accept triggers the
// server's Socket emit back to the requester (REQ-058); Decline and Block are
// silent. Block tears down any friendship + any reverse pending request in
// one backend transaction (spec R10).

"use client";

import { useState } from "react";
import { Check, X, Ban, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/avatar/Avatar";
import { Button } from "@/components/ui/button";
import {
  acceptFriendRequest,
  blockFromRequest,
  declineFriendRequest,
  type IncomingFriendRequest,
} from "@/lib/friendship-api";
import { BlossomEmptyState } from "@/components/empty/BlossomEmptyState";

interface IncomingTabProps {
  requests: IncomingFriendRequest[];
  loading: boolean;
  onMutate: () => void;
}

export function IncomingRequestsTab({ requests, loading, onMutate }: IncomingTabProps) {
  if (loading && requests.length === 0) {
    return <div className="py-8 text-sm text-muted-foreground">Loading requests…</div>;
  }
  if (requests.length === 0) {
    return <BlossomEmptyState tagline="No incoming requests." />;
  }
  return (
    <ul className="flex flex-col gap-2" aria-label="Incoming friend requests">
      {requests.map((r) => (
        <IncomingRow key={r.id} request={r} onMutate={onMutate} />
      ))}
    </ul>
  );
}

function IncomingRow({
  request,
  onMutate,
}: {
  request: IncomingFriendRequest;
  onMutate: () => void;
}) {
  const [busy, setBusy] = useState<"accept" | "decline" | "block" | null>(null);

  const handle = async (
    action: "accept" | "decline" | "block",
  ): Promise<void> => {
    setBusy(action);
    const r =
      action === "accept"
        ? await acceptFriendRequest(request.id)
        : action === "decline"
          ? await declineFriendRequest(request.id)
          : await blockFromRequest(request.id);
    setBusy(null);
    if (r.ok) {
      toast.success(
        action === "accept"
          ? `You and @${request.from.username} are now friends`
          : action === "decline"
            ? `Declined @${request.from.username}'s request`
            : `Blocked @${request.from.username}`,
      );
      onMutate();
    } else if (r.error.code === "already_friends") {
      toast.info("Already friends — refreshing.");
      onMutate();
    } else if (r.error.code === "request_declined") {
      toast.info("This request was already handled.");
      onMutate();
    } else if (r.error.code === "not_found") {
      toast.info("Request is no longer available — refreshing.");
      onMutate();
    } else {
      toast.error("Couldn't complete — try again.");
    }
  };

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
      <div className="flex items-center gap-3">
        <Avatar userId={request.from.userId} name={request.from.name} size={40} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-medium">{request.from.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            @{request.from.username}
            <span className="mx-1.5">·</span>
            <time dateTime={request.createdAt}>
              {relativeTime(request.createdAt)}
            </time>
          </div>
        </div>
      </div>
      {request.message ? (
        <p className="rounded bg-muted/60 px-3 py-2 text-sm text-foreground/90">
          {request.message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => handle("accept")}
          disabled={busy !== null}
          aria-label={`Accept request from ${request.from.username}`}
        >
          {busy === "accept" ? <Loader2 className="animate-spin" /> : <Check />}
          Accept
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => handle("decline")}
          disabled={busy !== null}
          aria-label={`Decline request from ${request.from.username}`}
        >
          {busy === "decline" ? <Loader2 className="animate-spin" /> : <X />}
          Decline
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => handle("block")}
          disabled={busy !== null}
          aria-label={`Block ${request.from.username}`}
          // UX(ui-pass P0-4) — dark-theme destructive loses saturation over
          // the incoming-request card; pin the fill so Block is visually
          // distinct from the neutral Decline button next to it.
          className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:bg-destructive/70 disabled:text-destructive-foreground disabled:opacity-100"
        >
          {busy === "block" ? <Loader2 className="animate-spin" /> : <Ban />}
          Block
        </Button>
      </div>
    </li>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}
