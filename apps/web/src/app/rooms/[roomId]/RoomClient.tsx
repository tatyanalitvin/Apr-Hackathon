// REQ-045: Room view — 3-column layout (rooms · messages+composer · members).
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  MessagePayload,
  MessageNewEvent,
  RoomDeletedEvent,
  RoomMemberJoinedEvent,
} from "@ai-herders/shared/protocol";
import { RequireSession } from "@/components/chat/RequireSession";
import { Header } from "@/components/chat/Header";
import { RoomList, type RoomListItem } from "@/components/chat/RoomList";
import { RoomSettingsModal } from "@/components/chat/RoomSettingsModal";
import { MemberList } from "@/components/chat/MemberList";
import { MessageList } from "@/components/chat/MessageList";
import { MessageComposer } from "@/components/chat/MessageComposer";
import { useSession } from "@/lib/auth-client";
import {
  attachPresenceBus,
  createChatSocket,
  createChatApi,
  type ChatSocket,
} from "@/lib/socket";
import { createWatermark } from "@/lib/watermark";
import { toast } from "sonner";
import type { MyRoomSummary } from "@/lib/chat-api";
import { useIdleDetector, type IdleState } from "@/lib/use-idle-detector";

const INITIAL_FIRST_INDEX = 1_000_000;
const HISTORY_PAGE_SIZE = 50;

// Fallback rendered only while /rooms/me hasn't answered yet — keeps the
// current room in the sidebar so the visit never dead-ends even if the
// caller has no other memberships.
const FALLBACK_ROOMS: RoomListItem[] = [{ id: "general", name: "general" }];

// Seeded non-self member list (the caller themselves is spliced in at render
// so their own pill renders with the real userId for live presence).
const SEEDED_OTHER_MEMBERS = [
  { id: "user-alice", username: "alice", displayName: "Alice" },
  { id: "user-bob", username: "bob", displayName: "Bob" },
  { id: "user-carol", username: "carol", displayName: "Carol" },
];

function RoomContent({ roomId }: { roomId: string }) {
  const { data } = useSession();
  const userId = data?.user?.id ?? "anon";
  const router = useRouter();
  const sessionUsername =
    data?.user && "username" in data.user
      ? (data.user as { username: string }).username
      : undefined;
  const sessionDisplayName = data?.user?.name;

  const [messages, setMessages] = useState<MessagePayload[]>([]);
  const [firstItemIndex, setFirstItemIndex] = useState(INITIAL_FIRST_INDEX);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  const [myRooms, setMyRooms] = useState<MyRoomSummary[] | null>(null);
  // REQ-103 — track the local idle state so the Header self-pill can render
  // it before the server round-trips `presence.changed` back.
  const [selfPresence, setSelfPresence] = useState<IdleState>("online");

  const apiRef = useRef(createChatApi());
  const socketRef = useRef<ChatSocket | null>(null);

  // Refresh the caller's membership list from the backend. Idempotent — we
  // re-call on room.member.joined so self-join (elsewhere in this tab) and
  // cross-tab joins both reconcile.
  const refreshMyRooms = useCallback(async () => {
    try {
      const rooms = await apiRef.current.listMyRooms();
      setMyRooms(rooms);
    } catch {
      // Non-fatal — fallback keeps the current room visible.
    }
  }, []);

  useEffect(() => {
    void refreshMyRooms();
  }, [refreshMyRooms]);

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

    // REQ-105 — pipe `presence.changed` into presenceStore so every
    // PresencePill mounted under this room picks up the transition.
    const detachPresence = attachPresenceBus(socket);

    const onMessageNew = (evt: MessageNewEvent) => {
      if (evt.roomId !== roomId) return;
      void watermarkRef.current.ingest(evt);
    };
    socket.on("message.new", onMessageNew);

    // S2 Q1 — a best-effort in-room notification when someone self-joins. We
    // only receive this for rooms already subscribed to (server uses
    // `.to(roomId).emit`), so a no-op in foreign rooms is guaranteed.
    const onMemberJoined = (_evt: RoomMemberJoinedEvent) => {
      void refreshMyRooms();
    };
    socket.on("room.member.joined", onMemberJoined);

    // REQ-089 — owner deletion kicks every subscriber out. The server emits
    // BEFORE the DB row vanishes so we still receive it while subscribed.
    // Show a toast so users understand why they were moved and navigate to
    // /rooms (the index page handles "which room to show next").
    const onRoomDeleted = (evt: RoomDeletedEvent) => {
      if (evt.roomId !== roomId) return;
      toast.info("This room was deleted by its owner.");
      router.replace("/rooms");
    };
    socket.on("room.deleted", onRoomDeleted);

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
      detachPresence();
      socket.off("message.new", onMessageNew);
      socket.off("room.member.joined", onMemberJoined);
      socket.off("room.deleted", onRoomDeleted);
      socket.emit("room.unsubscribe", roomId);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, refreshMyRooms, router]);

  // REQ-103 — local idle detector. Transitions go both to local state (so
  // the Header self-pill flips instantly) and out through the socket as
  // `presence.setState`, which the backend fans out to this user's rooms.
  useIdleDetector(
    useCallback((state: IdleState) => {
      setSelfPresence(state);
      socketRef.current?.emit("presence.setState", { state });
    }, []),
  );

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

  // Make sure the current room always appears even if /rooms/me hasn't yet
  // resolved (or transiently lacks membership while reconciling).
  const displayedRooms: RoomListItem[] = useMemo(() => {
    const base: RoomListItem[] = myRooms
      ? myRooms.map((r) => ({ id: r.id, name: r.name }))
      : FALLBACK_ROOMS;
    return base.some((r) => r.id === roomId)
      ? base
      : [...base, { id: roomId, name: roomId }];
  }, [myRooms, roomId]);

  // REQ-087/089 — surface the settings modal only when we have a membership
  // row for this room and it's a group room (DMs mutate via their own flow).
  const currentRoom = myRooms?.find((r) => r.id === roomId) ?? null;
  const settingsRole: "owner" | "member" | null = (() => {
    if (!currentRoom || currentRoom.kind !== "group") return null;
    if (data?.user?.id && currentRoom.ownerId === data.user.id) return "owner";
    return "member";
  })();

  // Splice the caller onto the top of the member list with their real id so
  // the self-pill is driven by the live presenceStore. Seeded alice/bob/carol
  // remain for visual density — their ids are placeholders until a real
  // room-member roster endpoint lands.
  const displayedMembers =
    data?.user?.id
      ? [
          {
            id: data.user.id,
            username: sessionUsername ?? "me",
            displayName: sessionDisplayName ?? "Me",
          },
          ...SEEDED_OTHER_MEMBERS,
        ]
      : SEEDED_OTHER_MEMBERS;

  return (
    <div className="h-dvh grid grid-cols-1 grid-rows-[auto_1fr_auto] lg:grid-cols-[16rem_1fr_18rem] lg:grid-rows-[auto_1fr]">
      <Header className="lg:col-span-3" selfPresence={selfPresence} />
      <nav className="hidden lg:block border-r min-h-0">
        <RoomList rooms={displayedRooms} currentRoomId={roomId} onRoomCreated={refreshMyRooms} />
      </nav>
      <main className="flex flex-col min-h-0 overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-2 text-sm font-semibold">
          <span>#{currentRoom?.name ?? roomId}</span>
          {settingsRole !== null ? (
            <RoomSettingsModal
              roomId={roomId}
              roomName={currentRoom?.name ?? roomId}
              role={settingsRole}
              onRenamed={refreshMyRooms}
              onLeftOrDeleted={refreshMyRooms}
            />
          ) : null}
        </div>
        <MessageList
          messages={messages}
          hasMoreOlder={hasMoreOlder}
          onLoadOlder={loadOlder}
          firstItemIndex={firstItemIndex}
        />
        <MessageComposer userId={userId} roomId={roomId} onSend={handleSend} onUpload={handleUpload} />
      </main>
      <aside className="hidden lg:block border-l min-h-0">
        <MemberList members={displayedMembers} />
      </aside>

      <div className="lg:hidden contents">
        <details className="border-t">
          <summary className="px-4 py-2 text-sm font-medium cursor-pointer">Rooms</summary>
          <RoomList rooms={displayedRooms} currentRoomId={roomId} onRoomCreated={refreshMyRooms} />
        </details>
        <details className="border-t">
          <summary className="px-4 py-2 text-sm font-medium cursor-pointer">Members ({displayedMembers.length})</summary>
          <MemberList members={displayedMembers} />
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
