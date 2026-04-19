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
import { useCallback, useEffect, useState } from "react";
import type { DmFrozenReason, DmListItem } from "@ai-herders/shared/protocol";
import { Badge } from "@/components/ui/badge";
import { createChatSocket } from "@/lib/socket";
import { listDms } from "@/lib/dms-api";
import { NewDmDialog } from "@/components/dm/NewDmDialog";

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
  return (
    <Link
      href={`/rooms/${dm.roomId}`}
      className={`block rounded px-3 py-1.5 text-sm hover:bg-accent ${
        active ? "bg-accent font-medium" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="truncate">{username}</span>
        {dm.frozen ? (
          <Badge variant="secondary" className="text-[10px] font-normal">
            {frozenLabel(dm.frozenReason)}
          </Badge>
        ) : null}
      </div>
      {preview ? (
        <div className="truncate text-xs text-muted-foreground">{preview}</div>
      ) : null}
    </Link>
  );
}

export function DmList({ currentRoomId }: { currentRoomId?: string }) {
  const [dms, setDms] = useState<DmListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await listDms();
    if (r.ok) {
      setDms(r.data);
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
  //   1. Any `message.new` event — last-message + ordering may change even
  //      for a DM the user isn't currently viewing.
  //   2. `dm:created` CustomEvent — NewDmDialog dispatches this on success
  //      so the row appears immediately without a full page reload.
  useEffect(() => {
    const socket = createChatSocket();
    const onMessageNew = () => void refresh();
    socket.on("message.new", onMessageNew);

    const onDmCreated = () => void refresh();
    window.addEventListener("dm:created", onDmCreated);

    return () => {
      socket.off("message.new", onMessageNew);
      socket.disconnect();
      window.removeEventListener("dm:created", onDmCreated);
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
        <div className="px-3 py-1.5 text-xs text-muted-foreground">
          No DMs yet.
        </div>
      ) : null}
      {dms?.map((dm) => (
        <DmRow key={dm.roomId} dm={dm} active={dm.roomId === currentRoomId} />
      ))}
    </div>
  );
}
