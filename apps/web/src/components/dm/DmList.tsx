// S2 DMs — sidebar section below the group room list.
//
// Fetches GET /api/v1/dms on mount. Refreshes when a `message.new` event
// lands (the last-message preview + ordering changes) and when a fresh DM
// is created via NewDmDialog (the `dm:created` CustomEvent).
//
// Each row shows counterpart username, a muted last-message preview, and
// a frozen badge with reason when the predicate fires. Clicking the row
// navigates to /rooms/:roomId — DM history reuses the group-room route.

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DmFrozenReason,
  DmListItem,
  MessageNewEvent,
} from "@ai-herders/shared/protocol";
import { Avatar } from "@/components/avatar/Avatar";
import { Badge } from "@/components/ui/badge";
import { UnreadBadge } from "@/components/chat/UnreadBadge";
import { createChatSocket } from "@/lib/socket";
import { listDms } from "@/lib/dms-api";
import { NewDmDialog } from "@/components/dm/NewDmDialog";

// Coalesce bursts of refresh triggers (e.g. a flurry of message.new events
// from the same active room) into a single GET /api/v1/dms. 300 ms is a
// human-imperceptible delay for sidebar reordering and is well below the
// per-IP rate-limit window. Pure UX heuristic — tune if it ever feels
// laggy on a slow socket.
const REFRESH_DEBOUNCE_MS = 300;

function frozenLabel(reason: DmFrozenReason | null): string {
  switch (reason) {
    case "user_deleted":
      return "account deleted";
    case "blocked":
      return "blocked";
    case "not_friends":
      return "not friends";
    default:
      return "frozen";
  }
}

function DmRow({ dm, active }: { dm: DmListItem; active: boolean }) {
  const username = dm.other.deleted ? "(deleted user)" : `@${dm.other.username}`;
  const preview = dm.lastMessage?.body ?? "";
  // Avatar hashes on userId; for a deleted counterpart we fall back to the
  // roomId so the placeholder still colour-stabilises per conversation
  // instead of flickering between renders.
  const avatarId = dm.other.deleted ? dm.roomId : dm.other.userId;
  const avatarName = dm.other.deleted ? "(deleted)" : dm.other.username;
  return (
    <Link
      href={`/rooms/${dm.roomId}`}
      className={`dm-row block rounded-md px-3 py-1.5 text-sm ${
        active ? "is-active font-medium" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <Avatar userId={avatarId} name={avatarName} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate">{username}</span>
            {dm.frozen ? (
              <Badge variant="secondary" className="text-[10px] font-normal">
                {frozenLabel(dm.frozenReason)}
              </Badge>
            ) : null}
            {/* REQ-214 — v3 §2.7.1/§4.4 unread badge. UnreadBadge itself
                returns null when count <= 0, so rows at zero render no extra
                node. */}
            <UnreadBadge
              count={dm.unreadCount ?? 0}
              current={active}
              className="ml-auto"
            />
          </div>
          {preview ? (
            <div className="truncate text-xs text-muted-foreground">{preview}</div>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

export function DmList({ currentRoomId }: { currentRoomId?: string }) {
  const [dms, setDms] = useState<DmListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track the in-flight refresh's AbortController so a newer refresh()
  // call cancels the older one. Without this, two concurrent fetches
  // could resolve out of order and the older response would clobber the
  // newer one (last-response-wins instead of last-request-wins). The
  // debounce below cuts most concurrency, but `dm:created` and
  // message.new can still race against the mount fetch.
  const inFlightRef = useRef<AbortController | null>(null);
  // Snapshot of current DM roomIds, kept in a ref so the message.new
  // handler can read the latest set without needing to be re-bound (and
  // re-attached as a socket listener) every time `dms` changes.
  const dmRoomIdsRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    inFlightRef.current?.abort();
    const controller = new AbortController();
    inFlightRef.current = controller;
    const r = await listDms(controller.signal);
    // If a newer refresh() has already aborted us (or kicked off its own
    // controller), drop this result on the floor — the newer caller owns
    // the next setDms.
    if (controller.signal.aborted || inFlightRef.current !== controller) {
      return;
    }
    if (r.ok) {
      setDms(r.data);
      dmRoomIdsRef.current = new Set(r.data.map((d) => d.roomId));
      setError(null);
    } else {
      // 401 is handled globally by RequireSession — anything else is a
      // transient network/server issue we can silently retry next time.
      setError(r.error.code);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep the list fresh on two signals:
  //   1. `message.new` events whose roomId matches one of OUR DMs —
  //      last-message + ordering may change even for a DM the user isn't
  //      currently viewing. We deliberately ignore events from group
  //      rooms (the only other emitter of message.new) because a chatty
  //      group would otherwise trigger dozens of pointless GET /dms
  //      round-trips per minute. The wire protocol does not currently
  //      carry a `roomKind` discriminator on MessageNewEvent, so we
  //      filter against our own known-DM roomId set instead. Trade-off:
  //      a brand-new DM initiated by the peer (no row in our list yet)
  //      will not auto-appear; it reconciles on the next mount / page
  //      navigation. Self-initiated DMs still surface immediately via
  //      the `dm:created` CustomEvent below.
  //      TODO(post-hackathon): add `roomKind` to MessageNewEvent so we
  //      can filter without depending on local list state.
  //   2. `dm:created` CustomEvent — NewDmDialog dispatches this on success
  //      so the row appears immediately without a full page reload.
  useEffect(() => {
    const socket = createChatSocket();

    // Tiny inline debounce — coalesces bursts (e.g. multi-message replies
    // arriving back-to-back in the same DM) into one GET. Pairs with the
    // AbortController in `refresh` so even if something bypasses the
    // debounce, out-of-order resolves still can't clobber newer state.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = (): void => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void refresh();
      }, REFRESH_DEBOUNCE_MS);
    };

    const onMessageNew = (evt: MessageNewEvent): void => {
      if (!dmRoomIdsRef.current.has(evt.roomId)) return;
      scheduleRefresh();
    };
    socket.on("message.new", onMessageNew);

    const onDmCreated = (): void => scheduleRefresh();
    window.addEventListener("dm:created", onDmCreated);

    return () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      socket.off("message.new", onMessageNew);
      socket.disconnect();
      window.removeEventListener("dm:created", onDmCreated);
      // Cancel any refresh that's still in flight when the component
      // unmounts so its (stale) response can't setState on a dead tree.
      inFlightRef.current?.abort();
      inFlightRef.current = null;
    };
  }, [refresh]);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-2 pt-3 pb-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Direct messages
        </div>
        <NewDmDialog />
      </div>
      {dms === null && !error ? (
        <div className="px-3 py-1.5 text-xs text-muted-foreground">Loading…</div>
      ) : null}
      {dms !== null && dms.length === 0 ? (
        <div
          className="mx-2 mt-1 rounded-md px-3 py-3 text-center text-xs text-muted-foreground"
          style={{
            background: "var(--glass-bg)",
            boxShadow: "inset 0 0 0 1px var(--glass-border)",
            backdropFilter: "blur(10px)",
            WebkitBackdropFilter: "blur(10px)",
          }}
        >
          <div className="mb-1 text-base leading-none" aria-hidden>
            🌸
          </div>
          No DMs yet — say hi.
        </div>
      ) : null}
      {dms && dms.length > 0 ? (
        <ul className="room-list-stagger space-y-0.5">
          {dms.map((dm) => (
            <li key={dm.roomId}>
              <DmRow dm={dm} active={dm.roomId === currentRoomId} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
