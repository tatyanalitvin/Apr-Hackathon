// NewDmDialog — directory-search typeahead with per-row relationship
// actions. Binding spec: docs/specs/s3-user-search.md §5.
//
// Row-action switch:
//   friend            → Start DM (createDm → /rooms/:roomId)
//   none              → Send friend request (POST /api/v1/friends/requests)
//   request_outgoing  → "Request sent" (disabled)
//   request_incoming  → Accept → /contacts (deep-link, no inline accept)

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
import { createDm, searchUsers } from "@/lib/dms-api";
import { BACKEND_URL, csrfHeaders } from "@/lib/backend";

const DEBOUNCE_MS = 300;
const MIN_QUERY = 2;

type RowStatus = "idle" | "sending" | "sent" | "dmming";

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

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY) {
      setHits(null);
      setLoading(false);
      setError(null);
      return;
    }
    const handle = setTimeout(async () => {
      inFlightRef.current = trimmed;
      setLoading(true);
      setError(null);
      const r = await searchUsers(trimmed);
      if (inFlightRef.current !== trimmed) return; // stale
      setLoading(false);
      if (r.ok) {
        setHits(r.data);
      } else {
        setHits(null);
        setError("Search failed — try again in a moment.");
      }
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
    toast.error("Couldn't start DM — try again.");
  }

  async function onSendFriendRequest(hit: UserSearchHit) {
    setRowStatus((s) => ({ ...s, [hit.userId]: "sending" }));
    try {
      const res = await fetch(`${BACKEND_URL}/api/v1/friends/requests`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ toUserId: hit.userId }),
      });
      if (res.status === 201 || res.status === 200) {
        setRowStatus((s) => ({ ...s, [hit.userId]: "sent" }));
      } else {
        setRowStatus((s) => ({ ...s, [hit.userId]: "idle" }));
        toast.error("Couldn't send friend request.");
      }
    } catch {
      setRowStatus((s) => ({ ...s, [hit.userId]: "idle" }));
      toast.error("Network error.");
    }
  }

  function onAccept() {
    setOpen(false);
    router.push("/contacts");
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
    // request_incoming
    return (
      <Button size="sm" variant="secondary" onClick={onAccept}>
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
