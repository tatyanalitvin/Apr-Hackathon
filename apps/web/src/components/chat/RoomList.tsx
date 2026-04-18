"use client";

import Link from "next/link";

export interface RoomListItem {
  id: string;
  name: string;
}

export function RoomList({ rooms, currentRoomId }: { rooms: RoomListItem[]; currentRoomId: string }) {
  return (
    <nav className="h-full overflow-auto p-3 space-y-1" aria-label="Rooms">
      <div className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Rooms</div>
      {rooms.map((room) => {
        const active = room.id === currentRoomId;
        return (
          <Link
            key={room.id}
            href={`/rooms/${room.id}`}
            className={`block rounded px-3 py-1.5 text-sm hover:bg-accent ${active ? "bg-accent font-medium" : ""}`}
          >
            #{room.name}
          </Link>
        );
      })}
      {/* TODO(S2): add "Create room" button once backend endpoint exists. */}
    </nav>
  );
}
