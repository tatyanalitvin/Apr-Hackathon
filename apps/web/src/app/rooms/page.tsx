// REQ-044: Room list (rooms the signed-in user is a member of).
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Hash } from "lucide-react";
import { RequireSession } from "@/components/chat/RequireSession";
import { Header } from "@/components/chat/Header";
import { Button } from "@/components/ui/button";
import { SakuraPetals } from "@/components/auth/SakuraPetals";
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
            with the centre CTA. A narrow-column variant (`v5-slim`) is tuned
            for the ~240px column; the centre petal-layer still drifts over the
            main section. */}
        <aside
          aria-hidden="true"
          className="hidden min-[1100px]:block relative w-[240px] shrink-0 overflow-hidden glass-panel m-3"
          style={{ color: "var(--text-lo)" }}
        >
          <SakuraPetals variant="v5" />
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
