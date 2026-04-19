"use client";

import Link from "next/link";
import { DmList } from "@/components/dm/DmList";
import { CreateRoomDialog } from "@/components/chat/CreateRoomDialog";
import { UnreadBadge } from "@/components/chat/UnreadBadge";

export interface RoomListItem {
  id: string;
  name: string;
  // REQ-120 — present when the caller has unread messages. Omit (or pass 0)
  // to skip the badge entirely.
  unreadCount?: number;
  // REQ-123 — gray the unread pill when the room is muted.
  muted?: boolean;
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
            className={`flex items-center justify-between gap-2 rounded px-3 py-1.5 text-sm hover:bg-accent ${active ? "bg-accent font-medium" : ""}`}
          >
            <span className="truncate">#{room.name}</span>
            <UnreadBadge
              count={room.unreadCount ?? 0}
              muted={room.muted}
              current={active}
            />
          </Link>
        );
      })}
      <DmList currentRoomId={currentRoomId} />
    </nav>
  );
}
