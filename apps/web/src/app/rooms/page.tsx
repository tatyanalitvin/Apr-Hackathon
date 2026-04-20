// REQ-044: Room list (rooms the signed-in user is a member of).
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RequireSession } from "@/components/chat/RequireSession";
import { Header } from "@/components/chat/Header";
import { Card, CardContent } from "@/components/ui/card";
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
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main id="main" className="flex-1 p-6">
        <div className="flex items-center justify-between mb-4 max-w-lg">
          <h1 className="text-2xl font-semibold">Your rooms</h1>
          <Link href="/rooms/browse">
            <Button variant="outline" size="sm">Browse rooms</Button>
          </Link>
        </div>
        {error ? (
          <div role="alert" className="text-sm text-destructive mb-3">{error}</div>
        ) : null}
        {rooms === null ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : rooms.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            You’re not in any rooms yet.{" "}
            <Link className="underline" href="/rooms/browse">Browse public rooms →</Link>
          </div>
        ) : (
          <ul className="space-y-2 max-w-lg">
            {rooms.map((room) => (
              <li key={room.id}>
                <Link href={`/rooms/${room.id}`}>
                  <Card className="hover:bg-accent cursor-pointer">
                    <CardContent className="py-3 px-4">
                      <div className="font-medium">#{room.name}</div>
                    </CardContent>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
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
