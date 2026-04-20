// REQ-044: Room list (rooms the signed-in user is a member of).
"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Hash } from "lucide-react";
import { RequireSession } from "@/components/chat/RequireSession";
import { Header } from "@/components/chat/Header";
import { Button } from "@/components/ui/button";
import { SakuraPetals } from "@/components/auth/SakuraPetals";
import { InboxList } from "@/components/invitations/InboxList";
import { RoomList, type RoomListItem } from "@/components/chat/RoomList";
import { createChatApi } from "@/lib/socket";
import { computeUnreadList } from "@/lib/unread";
import type { MyRoomSummary } from "@/lib/chat-api";

function RoomsContent() {
  const [rooms, setRooms] = useState<MyRoomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiRef] = useState(() => createChatApi());

  const refreshMyRooms = useCallback(async () => {
    try {
      const list = await apiRef.listMyRooms();
      setRooms(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load rooms");
    }
  }, [apiRef]);

  useEffect(() => {
    void refreshMyRooms();
  }, [refreshMyRooms]);

  // Re-use the same unread/muted plumbing RoomClient uses so the sidebar
  // badges are consistent whether you're on /rooms or inside a room.
  const displayedRooms: RoomListItem[] = useMemo(() => {
    if (!rooms) return [];
    const entries = computeUnreadList(rooms);
    const byId = new Map(entries.map((e) => [e.id, e]));
    return rooms.map((r) => {
      const e = byId.get(r.id);
      return {
        id: r.id,
        name: r.name,
        unreadCount: e?.count ?? 0,
        muted: e?.muted ?? false,
      };
    });
  }, [rooms]);

  return (
    <div className="flex flex-col h-dvh">
      <Header />
      <main id="main" className="flex flex-1 min-h-0">
        <aside className="hidden lg:flex lg:flex-col w-[256px] shrink-0 glass-panel m-3 overflow-y-auto">
          {error ? (
            <div role="alert" className="mx-3 mt-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          {rooms === null ? (
            <div className="px-5 pt-4 text-sm text-muted-foreground">Loading…</div>
          ) : (
            <>
              <InboxList onAccepted={refreshMyRooms} />
              {/* No active room on the index — pass an empty sentinel so
                  nothing is highlighted; DmList + CreateRoomDialog still
                  render their own controls. */}
              <RoomList
                rooms={displayedRooms}
                currentRoomId=""
                onRoomCreated={refreshMyRooms}
              />
            </>
          )}
        </aside>
        <section className="flex-1 flex flex-col min-w-0 relative">
          <div className="petal-layer" aria-hidden="true">
            <span className="petal" />
            <span className="petal" />
            <span className="petal" />
            <span className="petal" />
          </div>
          <h1 className="sr-only">Your rooms</h1>
          <div className="relative z-10 flex h-full items-center justify-center p-6">
            <div className="hero-stagger flex flex-col items-center text-center max-w-md">
              <div
                aria-hidden="true"
                className="mb-6 flex h-16 w-16 items-center justify-center rounded-full glass-panel"
                style={{ color: "var(--text-lo)" }}
              >
                <Hash className="!size-8" />
              </div>
              <h2 className="font-display text-3xl md:text-4xl mb-3 text-foreground">
                Pick a room to start reading.
              </h2>
              <p className="text-muted-foreground mb-6">
                Browse public rooms to join the conversation, or send a direct
                message to get started.
              </p>
              <div className="flex flex-col sm:flex-row items-center gap-3">
                <Link href="/rooms/browse">
                  <Button size="lg" className="send-btn">Browse rooms →</Button>
                </Link>
                <Link
                  href="/contacts"
                  className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  or send a DM
                </Link>
              </div>
            </div>
          </div>
        </section>
        {/* Empty right aside on the rooms index — fill the dead space with the
            sakura scene so the landing feels alive without competing for focus
            with the centre CTA. The `v6-fullbloom` variant is tuned for the
            ~240px column: short trunk + canopy-heavy silhouette; the centre
            petal-layer still drifts over the main section. */}
        <aside
          aria-hidden="true"
          className="hidden min-[1100px]:block relative w-[240px] shrink-0 overflow-hidden glass-panel m-3"
          style={{ color: "var(--text-lo)" }}
        >
          <SakuraPetals variant="v6" />
        </aside>
      </main>
    </div>
  );
}

export default function RoomsPage() {
  return (
    <RequireSession>
      <RoomsContent />
    </RequireSession>
  );
}
