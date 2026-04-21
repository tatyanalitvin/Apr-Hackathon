// REQ-051 — "+ Add friend" dialog. Mirrors the NewDmDialog search pattern
// (docs/specs/s3-user-search.md §5) so users pick a friend from a live
// directory typeahead instead of having to know the exact username. The
// previous blind-username input lost every hit on typos and was confusing
// relative to the DM flow the user already saw on the sidebar.
//
// Row-action switch (no DM start here — this dialog is scoped to adding):
//   none              → Send friend request
//   request_outgoing  → "Request sent" (disabled)
//   request_incoming  → Accept inline, row flips to "Already friends"
//   friend            → "Already friends" (disabled)

"use client";

import { useEffect, useRef, useState } from "react";
import { UserPlus } from "lucide-react";
import { toast } from "sonner";
import type { UserSearchHit } from "@ai-herders/shared/protocol";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { searchUsers } from "@/lib/dms-api";
import {
  acceptFriendRequest,
  listIncomingRequests,
  sendFriendRequest,
} from "@/lib/friendship-api";
import { toastForSendError } from "./AddFriendButton";

const DEBOUNCE_MS = 300;
const MIN_QUERY = 2;

type RowStatus = "idle" | "sending" | "sent" | "accepting";

export function AddFriendDialog({ onSent }: { onSent?: () => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<UserSearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({});
  // Guard against stale 300ms timers stomping newer results.
  const inFlightRef = useRef<string>("");
  // Mirrors `query` so the in-flight response handler can compare against the
  // live input instead of the closure-captured trimmed value (which goes
  // stale if the user clears/changes the query mid-request).
  const queryRef = useRef<string>("");
  // Inline-accept needs to re-read the directory so the accepted row flips
  // from request_incoming → friend without closing the dialog.
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    queryRef.current = query;
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY) {
      setHits(null);
      setLoading(false);
      setError(null);
      // Invalidate any in-flight request for a prior query so its resolve
      // doesn't write phantom results into the now-empty input, and replace
      // the refresh ref with a no-op so inline-accept callers don't re-fire
      // a stale search after the input was cleared.
      inFlightRef.current = "";
      refreshRef.current = async () => {};
      return;
    }
    const runSearch = async () => {
      inFlightRef.current = trimmed;
      setLoading(true);
      setError(null);
      const r = await searchUsers(trimmed);
      // Drop the response if the query moved on (including being cleared
      // below MIN_QUERY, which resets inFlightRef and queryRef).
      if (inFlightRef.current !== trimmed) return; // stale
      if (queryRef.current.trim() !== trimmed) return; // stale
      setLoading(false);
      if (r.ok) {
        setHits(r.data);
      } else {
        setHits(null);
        setError("Search failed — try again in a moment.");
      }
    };
    refreshRef.current = runSearch;
    const handle = setTimeout(() => {
      void runSearch();
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHits(null);
      setLoading(false);
      setError(null);
      setRowStatus({});
    }
  }, [open]);

  async function onSendFriendRequest(hit: UserSearchHit) {
    setRowStatus((s) => ({ ...s, [hit.userId]: "sending" }));
    const r = await sendFriendRequest({ toUserId: hit.userId });
    if (r.ok) {
      setRowStatus((s) => ({ ...s, [hit.userId]: "sent" }));
      toast.success(`Friend request sent to @${hit.username}`);
      onSent?.();
      return;
    }
    setRowStatus((s) => ({ ...s, [hit.userId]: "idle" }));
    toastForSendError(r.error);
  }

  async function onAcceptInline(hit: UserSearchHit) {
    setRowStatus((s) => ({ ...s, [hit.userId]: "accepting" }));
    const incoming = await listIncomingRequests();
    if (!incoming.ok) {
      setRowStatus((s) => ({ ...s, [hit.userId]: "idle" }));
      toast.error("Couldn't accept — try again.");
      return;
    }
    const match = incoming.data.find((req) => req.from.userId === hit.userId);
    if (!match) {
      setRowStatus((s) => ({ ...s, [hit.userId]: "idle" }));
      toast.info("This request is no longer available — refreshing.");
      await refreshRef.current();
      return;
    }
    const r = await acceptFriendRequest(match.id);
    if (r.ok) {
      toast.success(`You and @${hit.username} are now friends`);
      onSent?.();
      await refreshRef.current();
      setRowStatus((s) => ({ ...s, [hit.userId]: "idle" }));
      return;
    }
    setRowStatus((s) => ({ ...s, [hit.userId]: "idle" }));
    if (r.error.code === "already_friends") {
      toast.info("Already friends — refreshing.");
      await refreshRef.current();
    } else if (r.error.code === "request_declined" || r.error.code === "not_found") {
      toast.info("This request is no longer available.");
      await refreshRef.current();
    } else if (r.error.code === "rate_limited") {
      toast.error("Too many requests — try again in a moment.");
    } else {
      toast.error("Couldn't accept — try again.");
    }
  }

  function renderAction(hit: UserSearchHit) {
    const status = rowStatus[hit.userId] ?? "idle";
    if (hit.relationship === "friend") {
      return (
        <Button size="sm" variant="secondary" disabled>
          Already friends
        </Button>
      );
    }
    if (hit.relationship === "request_outgoing" || status === "sent") {
      return (
        <Button size="sm" variant="secondary" disabled>
          Request sent
        </Button>
      );
    }
    if (hit.relationship === "request_incoming") {
      return (
        <Button
          size="sm"
          variant="secondary"
          disabled={status === "accepting"}
          onClick={() => onAcceptInline(hit)}
        >
          Accept
        </Button>
      );
    }
    return (
      <Button
        size="sm"
        disabled={status === "sending"}
        onClick={() => onSendFriendRequest(hit)}
      >
        Send request
      </Button>
    );
  }

  const trimmed = query.trim();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="default">
          <UserPlus /> Add friend
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a friend</DialogTitle>
          <DialogDescription>
            Search by name or username — send a request with one click.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            type="search"
            role="searchbox"
            aria-label="Search users"
            autoFocus
            placeholder="Search by name or username"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          <div className="min-h-[8rem] space-y-1">
            {trimmed.length < MIN_QUERY ? (
              <div className="px-1 py-2 text-xs text-muted-foreground">
                Type at least 2 characters.
              </div>
            ) : loading ? (
              <>
                <div className="h-10 animate-pulse rounded bg-muted/40" />
                <div className="h-10 animate-pulse rounded bg-muted/40" />
                <div className="h-10 animate-pulse rounded bg-muted/40" />
              </>
            ) : error ? (
              <div className="px-1 py-2 text-xs text-destructive">{error}</div>
            ) : hits && hits.length === 0 ? (
              <div className="px-1 py-2 text-xs text-muted-foreground">
                No users match &quot;{trimmed}&quot;
              </div>
            ) : (
              hits?.map((hit) => (
                <div
                  key={hit.userId}
                  className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-accent"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">@{hit.username}</div>
                    <div className="truncate text-xs text-muted-foreground">{hit.name}</div>
                  </div>
                  {renderAction(hit)}
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
