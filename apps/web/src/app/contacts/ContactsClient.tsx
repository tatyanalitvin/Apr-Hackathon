// REQ-050 / REQ-057..059 / REQ-073..074 / REQ-136 — client container for the
// contacts page. Owns tab state, fetches each list, wires the Socket-driven
// friend.request.accepted refresh (REQ-058).

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Users, Inbox, Send, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { Header } from "@/components/chat/Header";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { FriendsTab } from "@/components/contacts/FriendsTab";
import { IncomingRequestsTab } from "@/components/contacts/IncomingRequestsTab";
import { OutgoingRequestsTab } from "@/components/contacts/OutgoingRequestsTab";
import { BlockedList } from "@/components/contacts/BlockedList";
import { AddFriendDialog } from "@/components/contacts/AddFriendDialog";
import {
  listBlockedUsers,
  listFriends,
  listIncomingRequests,
  listOutgoingRequests,
  type BlockedUser,
  type FriendSummary,
  type IncomingFriendRequest,
  type OutgoingFriendRequest,
} from "@/lib/friendship-api";
import { attachFriendshipBus, createChatSocket, type ChatSocket } from "@/lib/socket";
import { friendshipEvents } from "@/lib/friendship-events";

type TabValue = "friends" | "incoming" | "outgoing" | "blocked";

export function ContactsClient() {
  const [tab, setTab] = useState<TabValue>("friends");

  const [friends, setFriends] = useState<FriendSummary[]>([]);
  const [incoming, setIncoming] = useState<IncomingFriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingFriendRequest[]>([]);
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);

  const [loadingFriends, setLoadingFriends] = useState(true);
  const [loadingIncoming, setLoadingIncoming] = useState(true);
  const [loadingOutgoing, setLoadingOutgoing] = useState(true);
  const [loadingBlocked, setLoadingBlocked] = useState(false);
  const blockedFetchedOnce = useRef(false);

  const refetchFriends = useCallback(async () => {
    setLoadingFriends(true);
    const r = await listFriends();
    setLoadingFriends(false);
    if (r.ok) setFriends(r.data);
  }, []);

  const refetchIncoming = useCallback(async () => {
    setLoadingIncoming(true);
    const r = await listIncomingRequests();
    setLoadingIncoming(false);
    if (r.ok) setIncoming(r.data);
  }, []);

  const refetchOutgoing = useCallback(async () => {
    setLoadingOutgoing(true);
    const r = await listOutgoingRequests();
    setLoadingOutgoing(false);
    if (r.ok) setOutgoing(r.data);
  }, []);

  const refetchBlocked = useCallback(async () => {
    setLoadingBlocked(true);
    const r = await listBlockedUsers();
    setLoadingBlocked(false);
    if (r.ok) setBlocked(r.data);
  }, []);

  // Initial fetches on mount (Blocked is lazy — only when tab opens).
  useEffect(() => {
    void refetchFriends();
    void refetchIncoming();
    void refetchOutgoing();
  }, [refetchFriends, refetchIncoming, refetchOutgoing]);

  // Lazy-load Blocked on first Blocked-tab activation.
  useEffect(() => {
    if (tab === "blocked" && !blockedFetchedOnce.current) {
      blockedFetchedOnce.current = true;
      void refetchBlocked();
    }
  }, [tab, refetchBlocked]);

  // REQ-058 — subscribe to friend.request.accepted bus. Refetch Friends +
  // Outgoing (the two lists whose shape depends on the event). No inline
  // state patching from the event payload (brief rule 3).
  useEffect(() => {
    const off = friendshipEvents.subscribe((evt) => {
      toast.success(`@${evt.friendUsername} accepted your friend request`);
      void refetchFriends();
      void refetchOutgoing();
    });
    return off;
  }, [refetchFriends, refetchOutgoing]);

  // Socket lifecycle — one connection for the contacts page. The socket
  // auto-joins `user:{userId}` in the backend middleware, so we only need to
  // attach the bus. Refetch on reconnect (brief rule 4: recovers from missed
  // at-most-once events).
  const socketRef = useRef<ChatSocket | null>(null);
  useEffect(() => {
    const socket = createChatSocket();
    socketRef.current = socket;
    const detach = attachFriendshipBus(socket);

    const onReconnect = () => {
      void refetchFriends();
      void refetchIncoming();
      void refetchOutgoing();
    };
    socket.io.on("reconnect", onReconnect);

    return () => {
      detach();
      socket.io.off("reconnect", onReconnect);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [refetchFriends, refetchIncoming, refetchOutgoing]);

  const incomingCount = incoming.length;

  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main id="main" className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold leading-tight">Contacts</h1>
            <p className="text-sm text-muted-foreground">
              Manage your friends and friend requests.
            </p>
          </div>
          <AddFriendDialog onSent={refetchOutgoing} />
        </div>
        <Separator />
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="friends" className="gap-2">
              <Users className="h-4 w-4" aria-hidden /> Friends
              {friends.length > 0 ? (
                <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-xs tabular-nums">
                  {friends.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="incoming" className="gap-2">
              <Inbox className="h-4 w-4" aria-hidden /> Incoming
              {incomingCount > 0 ? (
                <Badge variant="destructive" className="ml-1 h-5 px-1.5 text-xs tabular-nums">
                  {incomingCount}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="outgoing" className="gap-2">
              <Send className="h-4 w-4" aria-hidden /> Sent
              {outgoing.length > 0 ? (
                <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-xs tabular-nums">
                  {outgoing.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="blocked" className="gap-2">
              <ShieldOff className="h-4 w-4" aria-hidden /> Blocked
            </TabsTrigger>
          </TabsList>
          <TabsContent value="friends" className="pt-4">
            <FriendsTab
              friends={friends}
              loading={loadingFriends}
              onMutate={refetchFriends}
            />
          </TabsContent>
          <TabsContent value="incoming" className="pt-4">
            <IncomingRequestsTab
              requests={incoming}
              loading={loadingIncoming}
              onMutate={() => {
                void refetchIncoming();
                void refetchFriends();
                void refetchBlocked();
              }}
            />
          </TabsContent>
          <TabsContent value="outgoing" className="pt-4">
            <OutgoingRequestsTab requests={outgoing} loading={loadingOutgoing} />
          </TabsContent>
          <TabsContent value="blocked" className="pt-4">
            <BlockedList
              blocked={blocked}
              loading={loadingBlocked}
              onMutate={() => {
                void refetchBlocked();
                void refetchFriends();
              }}
            />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
