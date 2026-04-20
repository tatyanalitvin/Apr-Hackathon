// REQ-025 / REQ-026: public-group catalog with self-join.
// §2.4.3: simple search — 300ms debounced ?q param passthrough.
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { LogIn, MessageSquare } from "lucide-react";
import { RequireSession } from "@/components/chat/RequireSession";
import { Header } from "@/components/chat/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BlossomEmptyState } from "@/components/empty/BlossomEmptyState";
import { createChatApi } from "@/lib/socket";
import { toast } from "sonner";
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
    async (roomId: string, roomName: string) => {
      setJoining(roomId);
      setError(null);
      const r = await apiRef.joinRoom(roomId);
      setJoining(null);
      if (r.ok) {
        // Mirror InboxList.tsx:103 parity — a success toast confirms the
        // join completed before the redirect unmounts the catalog row.
        toast.success(`Joined #${roomName}.`);
        router.push(`/rooms/${roomId}`);
        return;
      }
      // Map the specific join-error codes to dedicated user-facing copy.
      // Anything we don't recognise falls through to the generic inline
      // error below, preserving the previous behaviour for network/unknown.
      switch (r.error.code) {
        case "banned_from_room":
          toast.error("You're banned from this room.");
          return;
        case "room_not_joinable":
          toast.error("This room isn't joinable.");
          return;
        case "room_full":
          toast.error("This room is full.");
          return;
        case "rate_limited":
          toast.error("Slow down — try again in a moment.");
          return;
        case "unauthorized":
          toast.error("Please sign in again.");
          return;
        case "network":
          setError(r.error.message);
          return;
        default:
          setError("Join failed — try again.");
      }
    },
    [apiRef, router],
  );

  const hasQuery = query.trim().length > 0;

  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main id="main" className="flex-1 p-6">
        <div className="flex items-center justify-between mb-4 max-w-2xl">
          <h1 className="font-display text-4xl" style={{ color: "var(--text-hi)" }}>Browse rooms</h1>
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
          hasQuery ? (
            <div className="text-sm text-muted-foreground">No rooms match your search.</div>
          ) : (
            <BlossomEmptyState tagline="No public rooms yet. Ask someone to invite you." />
          )
        ) : (
          <div className="columns-1 gap-4 md:columns-2 xl:columns-3">
            {rooms.map((room) => (
              <article
                key={room.id}
                className="glass-panel mb-4 break-inside-avoid p-5 transition-all duration-200 hover:-translate-y-1 hover:rotate-[-0.5deg]"
              >
                <h2 className="font-display text-2xl mb-1" style={{ color: "var(--text-hi)" }}>
                  #{room.name}
                </h2>
                {room.description ? (
                  <p
                    className="text-sm mb-2"
                    style={{ color: "var(--text-lo)" }}
                    data-testid={`browse-description-${room.id}`}
                  >
                    {room.description}
                  </p>
                ) : null}
                <p className="text-xs mb-3" style={{ color: "var(--text-lo)" }}>
                  {room.memberCount} member{room.memberCount === 1 ? "" : "s"}
                </p>
                {room.isMember ? (
                  <Link href={`/rooms/${room.id}`}>
                    <Button size="sm" variant="outline">
                      <MessageSquare aria-hidden />
                      Open
                    </Button>
                  </Link>
                ) : (
                  <Button
                    size="sm"
                    // UX — Join is the primary CTA in each row; promote to the
                    // filled primary variant so it visually outranks the
                    // neutral Open-on-already-joined rows elsewhere in the
                    // catalog. P1-8 disabled treatment keeps the button
                    // readable mid-request rather than fading to 0.5.
                    variant="default"
                    onClick={() => void onJoin(room.id, room.name)}
                    disabled={joining === room.id}
                    className="disabled:bg-primary/70 disabled:opacity-100"
                  >
                    <LogIn aria-hidden />
                    {joining === room.id ? "Joining…" : "Join"}
                  </Button>
                )}
              </article>
            ))}
          </div>
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
