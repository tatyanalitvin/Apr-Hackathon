// REQ-045: Room view — 3-column layout (rooms · messages+composer · members).
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MessagePayload, MessageNewEvent } from "@ai-herders/shared/protocol";
import { RequireSession } from "@/components/chat/RequireSession";
import { Header } from "@/components/chat/Header";
import { RoomList } from "@/components/chat/RoomList";
import { MemberList } from "@/components/chat/MemberList";
import { MessageList } from "@/components/chat/MessageList";
import { MessageComposer } from "@/components/chat/MessageComposer";
import { useSession } from "@/lib/auth-client";
import { createChatSocket, createChatApi, type ChatSocket } from "@/lib/socket";
import { createWatermark } from "@/lib/watermark";

const INITIAL_FIRST_INDEX = 1_000_000;
const HISTORY_PAGE_SIZE = 50;

// S1 hardcoded membership (see spec R3).
const SEEDED_ROOMS = [{ id: "general", name: "general" }];
// Seeded member list (real backend presence fills this in S2).
const SEEDED_MEMBERS = [
  { id: "user-alice", username: "alice", displayName: "Alice", online: true },
  { id: "user-bob", username: "bob", displayName: "Bob", online: true },
  { id: "user-carol", username: "carol", displayName: "Carol", online: false },
];

function RoomContent({ roomId }: { roomId: string }) {
  const { data } = useSession();
  const userId = data?.user?.id ?? "anon";

  const [messages, setMessages] = useState<MessagePayload[]>([]);
  const [firstItemIndex, setFirstItemIndex] = useState(INITIAL_FIRST_INDEX);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);

  const apiRef = useRef(createChatApi());
  const socketRef = useRef<ChatSocket | null>(null);

  const emit = useCallback((m: MessagePayload) => {
    setMessages((prev) => {
      if (prev.some((x) => x.id === m.id)) return prev;
      return [...prev, m];
    });
  }, []);

  const fetchHistoryForWm = useCallback(
    async (rId: string, fromSeq: bigint, toSeq: bigint) => {
      return apiRef.current.fetchHistory(rId, { fromSeq, toSeq, limit: 500 });
    },
    [],
  );

  const watermarkRef = useRef(createWatermark(roomId, fetchHistoryForWm, emit));

  useEffect(() => {
    watermarkRef.current = createWatermark(roomId, fetchHistoryForWm, emit);
  }, [roomId, fetchHistoryForWm, emit]);

  useEffect(() => {
    const socket = createChatSocket();
    socketRef.current = socket;

    const onMessageNew = (evt: MessageNewEvent) => {
      if (evt.roomId !== roomId) return;
      void watermarkRef.current.ingest(evt);
    };
    socket.on("message.new", onMessageNew);

    let cancelled = false;
    void (async () => {
      await new Promise<void>((resolve) => {
        socket.emit("room.subscribe", roomId, (ack) => {
          if (cancelled) return resolve();
          watermarkRef.current.primeFromAck(ack.roomHeadSeq);
          resolve();
        });
      });

      const initial = await apiRef.current.fetchHistory(roomId, { limit: HISTORY_PAGE_SIZE });
      if (cancelled) return;
      const sorted = [...initial.messages].sort((a, b) =>
        BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0,
      );
      setMessages(sorted);
      setFirstItemIndex(INITIAL_FIRST_INDEX - sorted.length);
      setHasMoreOlder(sorted.length >= HISTORY_PAGE_SIZE);
    })();

    return () => {
      cancelled = true;
      socket.off("message.new", onMessageNew);
      socket.emit("room.unsubscribe", roomId);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId]);

  const loadOlder = useCallback(async () => {
    const oldest = messages[0];
    if (!oldest) return;
    const oldestSeq = BigInt(oldest.seq);
    if (oldestSeq <= 1n) {
      setHasMoreOlder(false);
      return;
    }
    const page = await apiRef.current.fetchHistory(roomId, {
      toSeq: oldestSeq - 1n,
      limit: HISTORY_PAGE_SIZE,
    });
    if (page.messages.length === 0) {
      setHasMoreOlder(false);
      return;
    }
    const sorted = [...page.messages].sort((a, b) =>
      BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0,
    );
    setMessages((prev) => [...sorted, ...prev]);
    setFirstItemIndex((prev) => prev - sorted.length);
    if (sorted.length < HISTORY_PAGE_SIZE) setHasMoreOlder(false);
  }, [messages, roomId]);

  const handleSend = useCallback(
    async (body: string, attachmentIds?: string[]) => {
      await apiRef.current.sendMessage(roomId, { body, attachmentIds });
    },
    [roomId],
  );

  const handleUpload = useCallback(
    async (file: File) => {
      return apiRef.current.uploadAttachment({ roomId, file });
    },
    [roomId],
  );

  return (
    <div className="h-dvh grid grid-cols-1 grid-rows-[auto_1fr_auto] lg:grid-cols-[16rem_1fr_18rem] lg:grid-rows-[auto_1fr]">
      <Header className="lg:col-span-3" />
      <nav className="hidden lg:block border-r min-h-0">
        <RoomList rooms={SEEDED_ROOMS} currentRoomId={roomId} />
      </nav>
      <main className="flex flex-col min-h-0 overflow-hidden">
        <div className="border-b px-4 py-2 text-sm font-semibold">#{roomId}</div>
        <MessageList
          messages={messages}
          hasMoreOlder={hasMoreOlder}
          onLoadOlder={loadOlder}
          firstItemIndex={firstItemIndex}
        />
        <MessageComposer userId={userId} roomId={roomId} onSend={handleSend} onUpload={handleUpload} />
      </main>
      <aside className="hidden lg:block border-l min-h-0">
        <MemberList members={SEEDED_MEMBERS} />
      </aside>

      <div className="lg:hidden contents">
        <details className="border-t">
          <summary className="px-4 py-2 text-sm font-medium cursor-pointer">Rooms</summary>
          <RoomList rooms={SEEDED_ROOMS} currentRoomId={roomId} />
        </details>
        <details className="border-t">
          <summary className="px-4 py-2 text-sm font-medium cursor-pointer">Members ({SEEDED_MEMBERS.length})</summary>
          <MemberList members={SEEDED_MEMBERS} />
        </details>
      </div>
    </div>
  );
}

export function RoomClient({ roomId }: { roomId: string }) {
  return (
    <RequireSession>
      <RoomContent roomId={roomId} />
    </RequireSession>
  );
}
