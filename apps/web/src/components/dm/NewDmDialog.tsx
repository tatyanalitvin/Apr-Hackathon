// NewDmDialog — directory-search typeahead with per-row relationship
// actions. Binding spec: docs/specs/s3-user-search.md §5.
//
// Row-action switch:
//   friend            → Start DM (createDm → /rooms/:roomId)
//   none              → Send friend request (typed sendFriendRequest helper)
//   request_outgoing  → "Request sent" (disabled)
//   request_incoming  → Accept inline, then show Start-DM affordance
//                       (no deep-link to /contacts — keeps the user in-flow).

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { UserSearchHit } from "@ai-herders/shared/protocol";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createDm, searchUsers, type DmError } from "@/lib/dms-api";
import {
  acceptFriendRequest,
  listIncomingRequests,
  sendFriendRequest,
} from "@/lib/friendship-api";
import { toastForSendError } from "@/components/contacts/AddFriendButton";

const DEBOUNCE_MS = 300;
const MIN_QUERY = 2;

type RowStatus = "idle" | "sending" | "sent" | "accepting" | "dmming";

function toastForDmStartError(error: DmError, username: string): void {
  switch (error.code) {
    case "dm_not_allowed":
      // Surfaces on the unfriended branch (remove-friend → DM no longer
      // allowed) — distinguished from the generic "try again" fallback.
      toast.error(`You can't DM @${username} right now — you're no longer friends.`);
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

export function NewDmDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<UserSearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({});
  // Track the q that fired the last request so a stale 300ms timer
  // doesn't clobber fresher results.
  const inFlightRef = useRef<string>("");
  // Mirrors `query` so the in-flight response handler can compare against the
  // live input instead of the closure-captured trimmed value (which goes
  // stale if the user clears/changes the query mid-request).
  const queryRef = useRef<string>("");
  // Refreshes after an inline accept need to re-read the directory so the
  // accepted row flips from request_incoming → friend.
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

  async function onStartDm(hit: UserSearchHit) {
    setRowStatus((s) => ({ ...s, [hit.userId]: "dmming" }));
    const r = await createDm(hit.userId);
    if (r.ok) {
      setOpen(false);
      window.dispatchEvent(new CustomEvent("dm:created"));
      router.push(`/rooms/${r.data.roomId}`);
      return;
    }
    setRowStatus((s) => ({ ...s, [hit.userId]: "idle" }));
    toastForDmStartError(r.error, hit.username);
  }

  async function onSendFriendRequest(hit: UserSearchHit) {
    setRowStatus((s) => ({ ...s, [hit.userId]: "sending" }));
    const r = await sendFriendRequest({ toUserId: hit.userId });
    if (r.ok) {
      setRowStatus((s) => ({ ...s, [hit.userId]: "sent" }));
      return;
    }
    setRowStatus((s) => ({ ...s, [hit.userId]: "idle" }));
    toastForSendError(r.error);
  }

  // Accept inline so the user can continue starting a DM without leaving the
  // dialog. UserSearchHit doesn't carry the incoming-request id, so we resolve
  // it via listIncomingRequests() before calling accept — a small extra RTT,
  // but it keeps the directory payload narrow and avoids a protocol change.
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
      // The request disappeared between the search and the click (accepted in
      // another tab, cancelled by sender, etc.). Refresh the directory so the
      // stale row is replaced.
      setRowStatus((s) => ({ ...s, [hit.userId]: "idle" }));
      toast.info("This request is no longer available — refreshing.");
      await refreshRef.current();
      return;
    }
    const r = await acceptFriendRequest(match.id);
    if (r.ok) {
      toast.success(`You and @${hit.username} are now friends`);
      // Keep the dialog + query intact per the brief; refetch so relationship
      // flips and the Start-DM affordance renders on the next paint.
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
        <Button
          size="sm"
          disabled={status === "dmming"}
          onClick={() => onStartDm(hit)}
        >
          Start DM
        </Button>
      );
    }
    if (hit.relationship === "none") {
      if (status === "sent") {
        return (
          <Button size="sm" variant="secondary" disabled>
            Request sent
          </Button>
        );
      }
      return (
        <Button
          size="sm"
          disabled={status === "sending"}
          onClick={() => onSendFriendRequest(hit)}
        >
          Send friend request
        </Button>
      );
    }
    if (hit.relationship === "request_outgoing") {
      return (
        <Button size="sm" variant="secondary" disabled>
          Request sent
        </Button>
      );
    }
    // request_incoming — accept inline; stay in the dialog so the user can
    // continue starting the DM once the row flips to "friend".
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

  const trimmed = query.trim();
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
          <DialogDescription>Search for someone by name or username.</DialogDescription>
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
