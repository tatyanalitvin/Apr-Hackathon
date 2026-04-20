// REQ-045: Room view — 3-column layout (rooms · messages+composer · members).
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  MessagePayload,
  MessageNewEvent,
  MessageEditedEvent,
  MessageDeletedEvent,
  RoomDeletedEvent,
  RoomMemberJoinedEvent,
  RoomUpdatedEvent,
} from "@ai-herders/shared/protocol";
import { RequireSession } from "@/components/chat/RequireSession";
import { Header } from "@/components/chat/Header";
import { RoomList, type RoomListItem } from "@/components/chat/RoomList";
import { InboxList } from "@/components/invitations/InboxList";
import { ManageRoomModal } from "@/components/chat/manage-room/ManageRoomModal";
import { MemberList, type MemberListItem } from "@/components/chat/MemberList";
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
import {
  applyMessageEditedReducer,
  applyMessageDeletedReducer,
} from "@/lib/reply-reducers";
import { toast } from "sonner";
import type { MyRoomSummary } from "@/lib/chat-api";
import { useIdleDetector, type IdleState } from "@/lib/use-idle-detector";
import { MuteToggle } from "@/components/chat/MuteToggle";
import { computeUnreadList } from "@/lib/unread";
import { useMarkRead } from "@/lib/use-mark-read";
import { useUnreadNotifications } from "@/lib/use-unread-notifications";

const INITIAL_FIRST_INDEX = 1_000_000;
const HISTORY_PAGE_SIZE = 50;

// Fallback rendered only while /rooms/me hasn't answered yet — keeps the
// current room in the sidebar so the visit never dead-ends even if the
// caller has no other memberships.
const FALLBACK_ROOMS: RoomListItem[] = [{ id: "general", name: "general" }];

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
  // REQ-110 R12/R13 — active reply target. MessageActions.Reply sets it from
  // a hovered row; MessageComposer renders the chip and carries replyToId
  // through on the next send. Room-scoped: resets whenever roomId changes.
  const [replyTo, setReplyTo] = useState<{
    messageId: string;
    authorUsername: string;
  } | null>(null);
  const [myRooms, setMyRooms] = useState<MyRoomSummary[] | null>(null);
  // Gate-3 patch — real roster keyed by user.id so PresencePill subscribes
  // to the correct presence slot. null until the fetch resolves; on failure
  // we fall back to self-only (see displayedMembers below).
  const [roomMembers, setRoomMembers] = useState<MemberListItem[] | null>(null);
  // REQ-103 — track the local idle state so the Header self-pill can render
  // it before the server round-trips `presence.changed` back.
  const [selfPresence, setSelfPresence] = useState<IdleState>("online");
  // REQ-120 — scroll-lock signal from MessageList gates debounced mark-read.
  const [atBottom, setAtBottom] = useState(true);
  // REQ-120/122 — focus state drives mark-read eligibility + title-flash
  // suppression for the focused tab.
  const [isFocused, setIsFocused] = useState(
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );

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

  // REQ-120 — lightweight polling of /rooms/me so unread badges for *other*
  // rooms surface without a page reload. The socket is only subscribed to
  // the current room, so we can't react to their message.new events directly.
  // 10s cadence keeps the network noise low for the 300-user brief while
  // still feeling "live" enough for the demo.
  useEffect(() => {
    const id = setInterval(() => {
      void refreshMyRooms();
    }, 10_000);
    return () => clearInterval(id);
  }, [refreshMyRooms]);

  // REQ-122 — track window focus so title flash / desktop notifications fire
  // only when the tab isn't the one the user is looking at. We update on
  // both `visibilitychange` (tab switches) and `focus/blur` (window switches).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () =>
      setIsFocused(document.visibilityState === "visible" && document.hasFocus());
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);

  // Fetch the real room roster so PresencePill keys on real userIds. Re-run
  // on roomId change and when a new member joins this room so the list stays
  // live for the demo flow (bob joins → alice sees bob in the panel).
  const refreshRoomMembers = useCallback(async () => {
    try {
      const members = await apiRef.current.listRoomMembers(roomId);
      setRoomMembers(members);
    } catch {
      // Non-fatal — displayedMembers falls back to self-only.
    }
  }, [roomId]);

  useEffect(() => {
    setRoomMembers(null);
    void refreshRoomMembers();
  }, [refreshRoomMembers]);

  // REQ-110 R12 — reply target is room-scoped: swap rooms, drop the chip so
  // the user doesn't accidentally post an ack into a different channel.
  useEffect(() => {
    setReplyTo(null);
  }, [roomId]);

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

    // REQ-110/111 — live reconcile on author edit. The event carries the new
    // body + editedAt only; seq is unchanged (brief §6 non-neg #5), so we
    // don't feed it through the watermark — we just patch the local row.
    // Messages that have been scrolled out of the window and evicted simply
    // no-op here (brief §1e "skip silently").
    const onMessageEdited = (evt: MessageEditedEvent) => {
      if (evt.roomId !== roomId) return;
      setMessages((prev) => applyMessageEditedReducer(prev, evt));
    };
    socket.on("message.edited", onMessageEdited);

    // REQ-112/113 — soft-delete arrival. Flip the row to tombstone mode by
    // setting deletedAt + clearing body/attachments. Row stays in the list so
    // seq continuity holds and the scroll position doesn't jump.
    // REQ-110 R11 — same reducer also flips replyTo on every reply whose
    // parent is this messageId, so quoted-blocks switch to `[deleted]` live.
    const onMessageDeleted = (evt: MessageDeletedEvent) => {
      if (evt.roomId !== roomId) return;
      setMessages((prev) => applyMessageDeletedReducer(prev, evt));
    };
    socket.on("message.deleted", onMessageDeleted);

    // S2 Q1 — a best-effort in-room notification when someone self-joins. We
    // only receive this for rooms already subscribed to (server uses
    // `.to(roomId).emit`), so a no-op in foreign rooms is guaranteed.
    const onMemberJoined = (_evt: RoomMemberJoinedEvent) => {
      void refreshMyRooms();
      void refreshRoomMembers();
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

    // REQ-022/087/088 — reconcile name/description/visibility on the open
    // header + sidebar row without waiting for the 10s /rooms/me poll.
    const onRoomUpdated = (evt: RoomUpdatedEvent) => {
      setMyRooms((prev) =>
        prev
          ? prev.map((r) =>
              r.id === evt.roomId
                ? {
                    ...r,
                    name: evt.name,
                    description: evt.description,
                    visibility: evt.visibility,
                  }
                : r,
            )
          : prev,
      );
    };
    socket.on("room.updated", onRoomUpdated);

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
      socket.off("message.edited", onMessageEdited);
      socket.off("message.deleted", onMessageDeleted);
      socket.off("room.member.joined", onMemberJoined);
      socket.off("room.deleted", onRoomDeleted);
      socket.off("room.updated", onRoomUpdated);
      socket.emit("room.unsubscribe", roomId);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, refreshMyRooms, refreshRoomMembers, router]);

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
    async (body: string, attachmentIds?: string[], replyToId?: string) => {
      // REQ-110 R12 — `replyToId` is the 3rd positional arg from
      // MessageComposer. Omitted entirely on non-reply sends so the POST
      // body doesn't emit a `replyToId` key server-side, keeping the wire
      // compatible with S1 callers that preceded this task.
      try {
        await apiRef.current.sendMessage(roomId, {
          body,
          attachmentIds,
          ...(replyToId ? { replyToId } : {}),
        });
      } catch (err) {
        // UX-08 — surface rate-limit / transport failures. sendMessage
        // throws `HTTP <status>: …` from fetchJson; translate the two
        // cases the user can act on (429 throttle, 413 too large) and
        // fall back to a generic send failure otherwise. Re-throw so the
        // composer keeps the draft for retry.
        const msg = err instanceof Error ? err.message : String(err);
        const m = /^HTTP\s+(\d+):/.exec(msg);
        const status = m ? Number(m[1]) : 0;
        if (status === 429) {
          toast.error("Slow down — message rate limit reached. Try again in a few seconds.");
        } else if (status === 413) {
          toast.error("Message too large to send.");
        } else {
          toast.error("Couldn't send message. Check your connection and try again.");
        }
        throw err;
      }
    },
    [roomId],
  );

  const handleReply = useCallback(
    (messageId: string, authorUsername: string) => {
      setReplyTo({ messageId, authorUsername });
    },
    [],
  );

  const handleClearReply = useCallback(() => {
    setReplyTo(null);
  }, []);

  const handleUpload = useCallback(
    // REQ-E-UI-COMPOSER-COMMENT — forward optional comment from the composer
    // into the backend multipart field. Ownership extension approved for this
    // narrow plumb-through on 2026-04-19.
    async (file: File, options?: { comment?: string }) => {
      return apiRef.current.uploadAttachment({ roomId, file, comment: options?.comment });
    },
    [roomId],
  );

  // REQ-120 — annotate rooms with unread counts (roomHeadSeq - lastReadSeq)
  // and mute state so RoomList renders the pills. For the currently open
  // room, we derive head seq from the live messages array so the count
  // reflects just-arrived messages before /rooms/me catches up.
  const currentHeadSeqLocal: bigint = useMemo(() => {
    let max = 0n;
    for (const m of messages) {
      try {
        const s = BigInt(m.seq);
        if (s > max) max = s;
      } catch {
        // malformed seq ignored — watermark contract says they're stringified bigints
      }
    }
    return max;
  }, [messages]);

  // REQ-110 — author clicks Save in the inline editor. We optimistic-update
  // so the edit lands in the UI before the server round-trip; the socket
  // `message.edited` broadcast will overwrite with the canonical row anyway,
  // so there's no risk of divergence. On error (auth, rate limit, 410) we
  // toast and rethrow so the form surfaces the failure.
  const handleEditMessage = useCallback(
    async (messageId: string, body: string) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, body } : m)),
      );
      const res = await apiRef.current.editMessage(roomId, messageId, body);
      if (!res.ok) {
        const msg =
          res.error.code === "gone"
            ? "Message was deleted."
            : res.error.code === "not_message_author"
              ? "You can only edit your own messages."
              : res.error.code === "rate_limited"
                ? "Slow down — try again in a moment."
                : res.error.code === "validation"
                  ? res.error.message
                  : "Edit failed.";
        toast.error(msg);
        throw new Error(msg);
      }
    },
    [roomId],
  );

  // REQ-112/113 — author clicks Confirm on the delete affordance. Optimistic
  // tombstone so the UI feels instant; the socket `message.deleted` event
  // will arrive and confirm (idempotent — same shape either way). Failures
  // revert via a refetch of the original row from history is overkill for
  // the hackathon — we toast and leave the optimistic state, since the next
  // reload pulls authoritative data from /messages anyway.
  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      const original = messages.find((m) => m.id === messageId);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                body: "",
                attachments: [],
                deletedAt: new Date().toISOString(),
              }
            : m,
        ),
      );
      const res = await apiRef.current.deleteMessage(roomId, messageId);
      if (!res.ok) {
        // Revert optimistic tombstone so the user isn't left staring at a
        // false delete after an authz failure.
        if (original) {
          setMessages((prev) =>
            prev.map((m) => (m.id === messageId ? original : m)),
          );
        }
        const msg =
          res.error.code === "not_message_author"
            ? "You can only delete your own messages."
            : res.error.code === "rate_limited"
              ? "Slow down — try again in a moment."
              : "Delete failed.";
        toast.error(msg);
      }
    },
    [messages, roomId],
  );

  // Make sure the current room always appears even if /rooms/me hasn't yet
  // resolved (or transiently lacks membership while reconciling).
  const displayedRooms: RoomListItem[] = useMemo(() => {
    if (!myRooms) {
      return FALLBACK_ROOMS.some((r) => r.id === roomId)
        ? FALLBACK_ROOMS
        : [...FALLBACK_ROOMS, { id: roomId, name: roomId }];
    }
    const entries = computeUnreadList(myRooms);
    const byId = new Map(entries.map((e) => [e.id, e]));
    const items = myRooms.map((r): RoomListItem => {
      const e = byId.get(r.id);
      return {
        id: r.id,
        name: r.name,
        unreadCount: e?.count ?? 0,
        muted: e?.muted ?? false,
      };
    });
    return items.some((r) => r.id === roomId)
      ? items
      : [...items, { id: roomId, name: roomId }];
  }, [myRooms, roomId]);

  // REQ-120 — debounced mark-read. Fire when the tab is focused AND the
  // list is scroll-locked at the bottom. We feed the hook the local head
  // seq so a burst of arrivals collapses into one POST per tick.
  useMarkRead({
    roomId,
    headSeq: currentHeadSeqLocal,
    canMarkRead: isFocused && atBottom && currentHeadSeqLocal > 0n,
    onMarked: useCallback(
      (seq: bigint) => {
        setMyRooms((prev) =>
          prev
            ? prev.map((r) =>
                r.id === roomId ? { ...r, lastReadSeq: seq.toString() } : r,
              )
            : prev,
        );
      },
      [roomId],
    ),
  });

  // REQ-121/122/124 — title flash + desktop notifications + cross-tab dedupe.
  useUnreadNotifications({ rooms: myRooms, currentRoomId: roomId });

  // REQ-087/089 — surface the settings modal only when we have a membership
  // row for this room and it's a group room (DMs mutate via their own flow).
  // REQ-209/210 — prefer the fetched role from /rooms/me so promoted admins
  // see the moderation tabs; fall back to ownerId comparison for older
  // backends that don't yet emit `role`.
  const currentRoom = myRooms?.find((r) => r.id === roomId) ?? null;
  const settingsRole: "owner" | "admin" | "member" | null = (() => {
    if (!currentRoom || currentRoom.kind !== "group") return null;
    if (currentRoom.role === "owner" || currentRoom.role === "admin") {
      return currentRoom.role;
    }
    if (currentRoom.role === "member") return "member";
    if (data?.user?.id && currentRoom.ownerId === data.user.id) return "owner";
    return "member";
  })();

  // Prefer the fetched roster (real user.id values → PresencePill subscribes
  // correctly). While the fetch is pending or if it fails, fall back to a
  // self-only list so the panel never collapses to empty mid-render.
  const selfEntry: MemberListItem | null = data?.user?.id
    ? {
        id: data.user.id,
        username: sessionUsername ?? "me",
        displayName: sessionDisplayName ?? "Me",
      }
    : null;
  const displayedMembers: MemberListItem[] =
    roomMembers ?? (selfEntry ? [selfEntry] : []);

  return (
    <div className="h-dvh grid grid-cols-1 grid-rows-[auto_1fr_auto] lg:grid-cols-[16rem_1fr_18rem] lg:grid-rows-[auto_1fr]">
      <Header className="lg:col-span-3" selfPresence={selfPresence} />
      <nav className="hidden lg:flex lg:flex-col border-r min-h-0 overflow-y-auto">
        <InboxList onAccepted={() => refreshMyRooms()} />
        <RoomList rooms={displayedRooms} currentRoomId={roomId} onRoomCreated={refreshMyRooms} />
      </nav>
      <main id="main" className="flex flex-col min-h-0 overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-2 text-sm font-semibold">
          <div className="min-w-0">
            <div>#{currentRoom?.name ?? roomId}</div>
            {currentRoom?.description ? (
              <div
                className="text-xs font-normal text-muted-foreground truncate"
                data-testid="room-description"
              >
                {currentRoom.description}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            {/* REQ-123 — bell toggle. Optimistically flip mutedUntil so the
                icon and RoomList pill change instantly; the /rooms/me poll
                reconciles authoritative server state. */}
            <MuteToggle
              roomId={roomId}
              mutedUntil={currentRoom?.mutedUntil ?? null}
              onChanged={(next) =>
                setMyRooms((prev) =>
                  prev
                    ? prev.map((r) =>
                        r.id === roomId ? { ...r, mutedUntil: next } : r,
                      )
                    : prev,
                )
              }
            />
            {settingsRole !== null ? (
              <ManageRoomModal
                roomId={roomId}
                roomName={currentRoom?.name ?? roomId}
                role={settingsRole}
                onRenamed={refreshMyRooms}
                onLeftOrDeleted={refreshMyRooms}
              />
            ) : null}
          </div>
        </div>
        <MessageList
          messages={messages}
          hasMoreOlder={hasMoreOlder}
          onLoadOlder={loadOlder}
          firstItemIndex={firstItemIndex}
          onAtBottomChange={setAtBottom}
          currentUserId={data?.user?.id}
          currentUserRole={settingsRole ?? undefined}
          roomKind={currentRoom?.kind}
          onEditMessage={handleEditMessage}
          onDeleteMessage={handleDeleteMessage}
          onReply={handleReply}
        />
        <MessageComposer
          userId={userId}
          roomId={roomId}
          onSend={handleSend}
          onUpload={handleUpload}
          replyTo={replyTo}
          onClearReply={handleClearReply}
        />
      </main>
      <aside className="hidden lg:block border-l min-h-0">
        <MemberList members={displayedMembers} />
      </aside>

      <div className="lg:hidden contents">
        <details className="border-t">
          <summary className="px-4 py-2 text-sm font-medium cursor-pointer">Rooms</summary>
          <InboxList onAccepted={() => refreshMyRooms()} />
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
