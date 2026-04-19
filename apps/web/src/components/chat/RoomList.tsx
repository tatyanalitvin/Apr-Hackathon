"use client";

import Link from "next/link";
import { DmList } from "@/components/dm/DmList";
import { CreateRoomDialog } from "@/components/chat/CreateRoomDialog";

export interface RoomListItem {
  id: string;
  name: string;
}

export function RoomList({
  rooms,
  currentRoomId,
  onRoomCreated,
}: {
  rooms: RoomListItem[];
  currentRoomId: string;
  onRoomCreated?: () => void;
}) {
  return (
    <nav className="h-full overflow-auto p-3 space-y-1" aria-label="Rooms">
      <div className="flex items-center justify-between px-2 mb-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Rooms
        </div>
        <CreateRoomDialog onCreated={onRoomCreated} />
      </div>
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
      <DmList currentRoomId={currentRoomId} />
    </nav>
  );
}
