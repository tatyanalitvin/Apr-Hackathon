// REQ-044: Room list (rooms the signed-in user is a member of).
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RequireSession } from "@/components/chat/RequireSession";
import { Header } from "@/components/chat/Header";
import { Button } from "@/components/ui/button";
import { createChatApi } from "@/lib/socket";
import type { MyRoomSummary } from "@/lib/chat-api";

function RoomsContent() {
  const [rooms, setRooms] = useState<MyRoomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = createChatApi();
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.listMyRooms();
        if (!cancelled) setRooms(list);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load rooms");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col h-dvh">
      <Header />
      <main id="main" className="flex flex-1 min-h-0">
        <aside className="hidden lg:flex lg:flex-col w-[256px] shrink-0 glass-panel m-3 p-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-semibold">Rooms</span>
            <Link href="/rooms/browse">
              <Button variant="outline" size="sm">Browse</Button>
            </Link>
          </div>
          {error ? (
            <div role="alert" className="text-sm text-destructive mb-3">{error}</div>
          ) : null}
          {rooms === null ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : rooms.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              You&apos;re not in any rooms yet.{" "}
              <Link className="underline" href="/rooms/browse">Browse public rooms →</Link>
            </div>
          ) : (
            <ul className="space-y-1">
              {rooms.map((room) => (
                <li key={room.id}>
                  <Link
                    href={`/rooms/${room.id}`}
                    className="block rounded px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    #{room.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <section className="flex-1 flex flex-col min-w-0 relative">
          <h1 className="sr-only">Your rooms</h1>
          <div className="flex h-full items-center justify-center">
            <p className="font-display italic text-2xl" style={{ color: "var(--text-lo)" }}>
              Pick a room to start reading.
            </p>
          </div>
        </section>
        <aside className="hidden min-[1100px]:flex min-[1100px]:flex-col w-[240px] shrink-0 glass-panel m-3 p-4 overflow-y-auto" style={{ color: "var(--text-lo)" }}>
          {/* members panel — empty on the rooms index */}
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
