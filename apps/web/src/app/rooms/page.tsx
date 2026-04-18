// REQ-044: Room list (rooms the signed-in user is a member of).
"use client";

import Link from "next/link";
import { RequireSession } from "@/components/chat/RequireSession";
import { Header } from "@/components/chat/Header";
import { Card, CardContent } from "@/components/ui/card";

// TODO(S2): replace hardcoded list with `GET /api/v1/rooms/me`.
const SEEDED_ROOMS = [{ id: "general", name: "general" }] as const;

function RoomsContent() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main className="flex-1 p-6">
        <h1 className="text-2xl font-semibold mb-4">Your rooms</h1>
        <ul className="space-y-2 max-w-lg">
          {SEEDED_ROOMS.map((room) => (
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
