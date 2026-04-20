// Session-scoped cache of the caller's blocked user IDs.
//
// REQ-053 says the UI shouldn't render "Add friend" for users the caller has
// blocked, even though the backend will happily insert the request
// (caller→target block is a REAL insert; see the REQ-053 reverse-direction
// test in friends-send-blocked.test.ts). AddFriendButton lives inside
// MemberList rows — fetching the blocklist per-row is wasteful, so we share
// a single in-flight promise across all subscribers and expose a refresh()
// other mutation paths (block/unblock) can call when the list changes.

"use client";

import { useEffect, useState } from "react";
import { listBlockedUsers } from "./friendship-api";

let cache: Set<string> | null = null;
let inflight: Promise<Set<string>> | null = null;
const listeners = new Set<(ids: Set<string>) => void>();

async function fetchOnce(): Promise<Set<string>> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const r = await listBlockedUsers();
    const ids = r.ok ? new Set(r.data.map((b) => b.userId)) : new Set<string>();
    cache = ids;
    inflight = null;
    for (const fn of listeners) fn(ids);
    return ids;
  })();
  return inflight;
}

export function refreshMyBlocks(): Promise<Set<string>> {
  cache = null;
  inflight = null;
  return fetchOnce();
}

export function useMyBlockedUserIds(): Set<string> | null {
  const [ids, setIds] = useState<Set<string> | null>(cache);

  useEffect(() => {
    let cancelled = false;
    if (!cache) {
      void fetchOnce().then((next) => {
        if (!cancelled) setIds(next);
      });
    }
    const listener = (next: Set<string>) => {
      if (!cancelled) setIds(next);
    };
    listeners.add(listener);
    return () => {
      cancelled = true;
      listeners.delete(listener);
    };
  }, []);

  return ids;
}
