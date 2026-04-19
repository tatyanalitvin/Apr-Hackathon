// REQ-025 / REQ-026: public-group catalog with self-join.
// §2.4.3: simple search — 300ms debounced ?q param passthrough.
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { RequireSession } from "@/components/chat/RequireSession";
import { Header } from "@/components/chat/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createChatApi } from "@/lib/socket";
import type { RoomCatalogEntry } from "@/lib/chat-api";

// §2.4.3 — 300ms matches the composer draft-debounce cadence. Same feel as
// the rest of the app's typing affordances; no need for a new constant.
const SEARCH_DEBOUNCE_MS = 300;

function BrowseContent() {
  const router = useRouter();
  const [rooms, setRooms] = useState<RoomCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [apiRef] = useState(() => createChatApi());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce query → debouncedQuery. Avoids re-fetching on every keystroke.
  // Cleanup cancels in-flight timers on unmount / fast re-type.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const loadCatalog = useCallback(async () => {
    try {
      const list = await apiRef.listRoomCatalog({ q: debouncedQuery });
      setRooms(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load catalog");
    }
  }, [apiRef, debouncedQuery]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const onJoin = useCallback(
    async (roomId: string) => {
      setJoining(roomId);
      setError(null);
      try {
        await apiRef.joinRoom(roomId);
        router.push(`/rooms/${roomId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Join failed");
      } finally {
        setJoining(null);
      }
    },
    [apiRef, router],
  );

  const hasQuery = query.trim().length > 0;

  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main className="flex-1 p-6">
        <div className="flex items-center justify-between mb-4 max-w-2xl">
          <h1 className="text-2xl font-semibold">Browse rooms</h1>
          <Link href="/rooms">
            <Button variant="ghost" size="sm">← Your rooms</Button>
          </Link>
        </div>

        <div className="mb-3 max-w-2xl">
          <Input
            type="search"
            aria-label="Search rooms"
            placeholder="Search rooms…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {error ? (
          <div role="alert" className="text-sm text-destructive mb-3">{error}</div>
        ) : null}

        {rooms === null ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : rooms.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            {hasQuery ? "No rooms match your search." : "No public rooms yet."}
          </div>
        ) : (
          <ul className="space-y-2 max-w-2xl">
            {rooms.map((room) => (
              <li key={room.id}>
                <Card>
                  <CardContent className="py-3 px-4 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="font-medium truncate">#{room.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {room.memberCount} member{room.memberCount === 1 ? "" : "s"}
                      </div>
                    </div>
                    {room.isMember ? (
                      <Link href={`/rooms/${room.id}`}>
                        <Button size="sm" variant="outline">Open</Button>
                      </Link>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => void onJoin(room.id)}
                        disabled={joining === room.id}
                      >
                        {joining === room.id ? "Joining…" : "Join"}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

export default function BrowseRoomsPage() {
  return (
    <RequireSession>
      <BrowseContent />
    </RequireSession>
  );
}
