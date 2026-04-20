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
import { ChatComposer } from "@/components/chat/ChatComposer";
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
import { listDms } from "@/lib/dms-api";
import type { DmFrozenReason } from "@ai-herders/shared/protocol";
import { useIdleDetector, type IdleState } from "@/lib/use-idle-detector";
import { MuteToggle } from "@/components/chat/MuteToggle";
import { computeUnreadList } from "@/lib/unread";
import { useMarkRead } from "@/lib/use-mark-read";
import { useUnreadNotifications } from "@/lib/use-unread-notifications";
import { makeAiFixtures } from "@/lib/chat/ai-fixtures";

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

  // REQ-066 — DM-specific UI state.
  //   `dmPeer` populates the header + composer placeholder with the
  //   counterpart's display-name/username so DM threads never render the raw
  //   roomId (UUID). Fetched from GET /api/v1/dms.
  //   `dmFrozenReason` drives the composer banner + disable; we prefer the
  //   proactive flag from /dms, but also flip it on a 409 `dialog_frozen`
  //   from send so a friendship revoked mid-session surfaces without waiting
  //   for the /dms polling cadence.
  const [dmPeer, setDmPeer] = useState<{
    userId: string;
    username: string;
    name: string;
    deleted: boolean;
  } | null>(null);
  const [dmFrozenReason, setDmFrozenReason] = useState<DmFrozenReason | null>(
    null,
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

  // REQ-066 — pull DM metadata (counterpart + frozen flag) from /api/v1/dms.
  // Cheap enough for the demo (<1 KB/row) and keeps the freeze banner reactive
  // to friendship revocations without wiring a bespoke /dms/:id endpoint.
  // Reset on roomId change so navigating group → DM or DM → group never leaves
  // stale peer/frozen state on screen.
  const refreshDmMeta = useCallback(async () => {
    const r = await listDms();
    if (!r.ok) return;
    const hit = r.data.find((d) => d.roomId === roomId);
    if (!hit) {
      // Not a DM (or not one we're party to) — clear any stale state.
      setDmPeer(null);
      setDmFrozenReason(null);
      return;
    }
    setDmPeer(hit.other);
    setDmFrozenReason(hit.frozen ? hit.frozenReason : null);
  }, [roomId]);

  useEffect(() => {
    setDmPeer(null);
    setDmFrozenReason(null);
    void refreshDmMeta();
  }, [refreshDmMeta]);

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

  // REQ-110/112 — edit/delete reducer application routed through the
  // watermark queue so it never applies ahead of a still-draining backfill.
  const applyMutation = useCallback(
    (evt: MessageEditedEvent | MessageDeletedEvent) => {
      if (evt.type === "message.edited") {
        setMessages((prev) => applyMessageEditedReducer(prev, evt));
      } else {
        setMessages((prev) => applyMessageDeletedReducer(prev, evt));
      }
    },
    [],
  );

  const watermarkRef = useRef(
    createWatermark(roomId, fetchHistoryForWm, emit, applyMutation),
  );

  useEffect(() => {
    watermarkRef.current = createWatermark(
      roomId,
      fetchHistoryForWm,
      emit,
      applyMutation,
    );
  }, [roomId, fetchHistoryForWm, emit, applyMutation]);

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

    // REQ-110/111 — live reconcile on author edit. We route through the
    // watermark queue so a mutation that arrives while a backfill is still
    // in flight can't patch a row that hasn't been emitted yet. The edit
    // event's own seq equals the target message's seq and doesn't advance
    // the allocator; `roomHeadSeq` drives gap-detection for any new-message
    // events that may have raced ahead.
    const onMessageEdited = (evt: MessageEditedEvent) => {
      if (evt.roomId !== roomId) return;
      void watermarkRef.current.ingestMutation(evt);
    };
    socket.on("message.edited", onMessageEdited);

    // REQ-112/113 — soft-delete arrival. Flip the row to tombstone mode by
    // setting deletedAt + clearing body/attachments. Row stays in the list so
    // seq continuity holds and the scroll position doesn't jump.
    // REQ-110 R11 — same reducer also flips replyTo on every reply whose
    // parent is this messageId, so quoted-blocks switch to `[deleted]` live.
    // Same watermark routing as edits — keeps edit+delete+new strictly
    // ordered by arrival with no race against in-flight backfills.
    const onMessageDeleted = (evt: MessageDeletedEvent) => {
      if (evt.roomId !== roomId) return;
      void watermarkRef.current.ingestMutation(evt);
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

    // After a transient disconnect Socket.IO auto-reconnects, but the server
    // drops the room subscription on disconnect — any `message.new` fired
    // while we were offline is gone. Re-emit `room.subscribe` to rejoin the
    // fanout room, then let the watermark backfill the gap by feeding
    // the returned head seq through primeFromAck and fetching history for
    // any seqs we missed (lastSeen+1 .. newHead). Mirrors InboxList + Contacts.
    const onReconnect = () => {
      socket.emit("room.subscribe", roomId, (ack) => {
        const head = BigInt(ack.roomHeadSeq);
        const lastSeen = watermarkRef.current.getLastSeenSeq();
        if (head > lastSeen) {
          // Use the same gap-fill path as a live message.new arriving at the
          // current head — fetchHistory covers lastSeen+1..head, emit patches
          // the list, and primeFromAck advances the watermark if the slice
          // came back empty.
          void (async () => {
            const fromSeq = lastSeen + 1n;
            try {
              const slice = await fetchHistoryForWm(roomId, fromSeq, head);
              const sorted = [...slice.messages].sort((a, b) => {
                const av = BigInt(a.seq);
                const bv = BigInt(b.seq);
                return av < bv ? -1 : av > bv ? 1 : 0;
              });
              for (const m of sorted) emit(m);
            } finally {
              watermarkRef.current.primeFromAck(ack.roomHeadSeq);
            }
          })();
        } else {
          watermarkRef.current.primeFromAck(ack.roomHeadSeq);
        }
      });
      // DM peer/frozen state may have shifted while offline — refresh so the
      // composer banner/placeholder reflect current friendship state.
      void refreshDmMeta();
      void refreshRoomMembers();
    };
    socket.io.on("reconnect", onReconnect);

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
      // Merge-don't-replace: live `message.new` events that arrive while the
      // history fetch is in flight are appended via `emit`. A naive
      // `setMessages(sorted)` clobbers them whenever the snapshot's head
      // precedes the live event's seq — a race that shows up as a silently
      // dropped message under rapid-send bursts right after page load.
      setMessages((prev) => {
        if (prev.length === 0) return sorted;
        const byId = new Map<string, MessagePayload>();
        for (const m of sorted) byId.set(m.id, m);
        for (const m of prev) byId.set(m.id, m);
        return Array.from(byId.values()).sort((a, b) =>
          BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0,
        );
      });
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
      socket.io.off("reconnect", onReconnect);
      socket.emit("room.unsubscribe", roomId);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [
    roomId,
    refreshMyRooms,
    refreshRoomMembers,
    refreshDmMeta,
    router,
    emit,
    fetchHistoryForWm,
  ]);

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
        } else if (status === 409 && /dialog_frozen/.test(msg)) {
          // REQ-066 — DM freeze enforcement. The proactive /dms fetch
          // usually catches this upfront, but if a friendship is revoked
          // while a thread is open the first send is what reveals it.
          // Parse the reason off the error body; fall back to not_friends
          // (the only reason we disable-but-allow-preview today).
          const reasonMatch = /"reason"\s*:\s*"([^"]+)"/.exec(msg);
          const reason = (reasonMatch?.[1] as DmFrozenReason | undefined) ??
            "not_friends";
          setDmFrozenReason(reason);
          toast.error("This conversation is frozen.");
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
  // revert to the captured pre-edit snapshot so the "(edited)" pill doesn't
  // stick on a row whose edit never landed.
  const handleEditMessage = useCallback(
    async (messageId: string, body: string) => {
      // Capture the pre-edit snapshot BEFORE the optimistic setter so a
      // failure can restore the original body + editedAt. Without this the
      // user sees a persistent "(edited)" pill on a row that in fact still
      // holds the pre-edit body (the server rejected the mutation).
      let snapshot: MessagePayload | null = null;
      setMessages((prev) => {
        const next = prev.map((m) => {
          if (m.id !== messageId) return m;
          snapshot = m;
          // REQ-110 — stamp editedAt locally so the "(edited)" pill flips
          // on immediately. The server broadcast overwrites with the
          // canonical value; until then the local ISO is close enough.
          return {
            ...m,
            body,
            editedAt: new Date().toISOString(),
          };
        });
        return next;
      });
      const res = await apiRef.current.editMessage(roomId, messageId, body);
      if (!res.ok) {
        // Revert to snapshot — restore original body + editedAt (may be null
        // for a first-ever edit).
        if (snapshot) {
          const original: MessagePayload = snapshot;
          setMessages((prev) =>
            prev.map((m) => (m.id === messageId ? original : m)),
          );
        }
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

  const displayMessages = (() => {
    if (process.env.NEXT_PUBLIC_AI_FIXTURES !== "1") return messages;
    const last = messages[messages.length - 1];
    const base = last ? Number(last.seq) : 0;
    return [...messages, ...makeAiFixtures(roomId, base)];
  })();

  return (
    <div className="flex flex-col h-dvh">
      <Header selfPresence={selfPresence} />
      <main id="main" className="flex flex-col lg:flex-row flex-1 min-h-0">
        <aside className="hidden lg:flex lg:flex-col w-[256px] shrink-0 glass-panel m-3 p-4 overflow-y-auto">
          <InboxList onAccepted={() => refreshMyRooms()} />
          <RoomList rooms={displayedRooms} currentRoomId={roomId} onRoomCreated={refreshMyRooms} />
        </aside>
        <section className="flex-1 flex flex-col min-w-0 relative">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <div className="min-w-0">
              <h2>
                <span className="font-display text-[28px] leading-tight" style={{ letterSpacing: "-0.01em" }}>
                  #{currentRoom?.name ?? roomId}
                </span>
              </h2>
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
            messages={displayMessages}
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
          <ChatComposer>
            <MessageComposer
              userId={userId}
              roomId={roomId}
              roomName={currentRoom?.name ?? roomId}
              onSend={handleSend}
              onUpload={handleUpload}
              replyTo={replyTo}
              onClearReply={handleClearReply}
            />
          </ChatComposer>
        </section>
        {/*
          REQ-045: single MemberList instance — renders once across breakpoints
          to avoid a duplicate presence-store subscription and duplicate ARIA
          landmark. Below 1024px it shows as an accordion inside <main> (which
          is flex-col at that range); between 1024–1099px it is hidden (parity
          with prior behavior); at ≥1100px it becomes the right-rail pane with
          the <summary> hidden so <details open> behaves like a static panel.
        */}
        <details
          open
          className="max-lg:block lg:hidden min-[1100px]:flex min-[1100px]:flex-col w-full min-[1100px]:w-[240px] shrink-0 max-lg:border-t min-[1100px]:glass-panel min-[1100px]:m-3 min-[1100px]:p-4 overflow-y-auto"
          style={{ color: "var(--text-lo)" }}
        >
          <summary className="px-4 py-2 text-sm font-medium cursor-pointer min-[1100px]:hidden">
            Members ({displayedMembers.length})
          </summary>
          <MemberList members={displayedMembers} selfPresence={selfPresence} />
        </details>
      </main>

      {/* Mobile accordion fallback — shown below 1024px */}
      <div className="lg:hidden contents">
        <details className="border-t">
          <summary className="px-4 py-2 text-sm font-medium cursor-pointer">Rooms</summary>
          <InboxList onAccepted={() => refreshMyRooms()} />
          <RoomList rooms={displayedRooms} currentRoomId={roomId} onRoomCreated={refreshMyRooms} />
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
