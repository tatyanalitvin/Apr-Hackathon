// REQ-047: Virtualized message list with lazy older-page loading.
// REQ-048: Auto-scroll pin + "↓ N new messages" pill when user is scrolled up.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { MessagePayload } from "@ai-herders/shared/protocol";
import { Button } from "@/components/ui/button";

export interface MessageListProps {
  messages: MessagePayload[];
  hasMoreOlder: boolean;
  onLoadOlder: () => Promise<void> | void;
  firstItemIndex: number;
}

export function MessageList({ messages, hasMoreOlder, onLoadOlder, firstItemIndex }: MessageListProps) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const lastMessageCountRef = useRef(messages.length);
  const ref = useRef<VirtuosoHandle>(null);

  // When new messages arrive while user is NOT at bottom, bump unreadCount.
  useEffect(() => {
    const delta = messages.length - lastMessageCountRef.current;
    if (delta > 0 && !isAtBottom) setUnreadCount((n) => n + delta);
    lastMessageCountRef.current = messages.length;
  }, [messages.length, isAtBottom]);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setIsAtBottom(atBottom);
    if (atBottom) setUnreadCount(0);
  }, []);

  const handleStartReached = useCallback(() => {
    if (hasMoreOlder) void onLoadOlder();
  }, [hasMoreOlder, onLoadOlder]);

  const scrollToBottom = useCallback(() => {
    ref.current?.scrollToIndex({ index: "LAST", behavior: "smooth", align: "end" });
    setUnreadCount(0);
  }, []);

  return (
    <div className="relative flex-1 min-h-0">
      <Virtuoso
        ref={ref}
        data={messages}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={messages.length - 1}
        followOutput={(atBottom) => (atBottom ? "smooth" : false)}
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={100}
        startReached={handleStartReached}
        itemContent={(_index, message) => <MessageRow message={message} />}
        components={{
          Header: () => hasMoreOlder ? <div className="p-4 text-center text-xs text-muted-foreground">Loading older…</div> : null,
        }}
      />
      {unreadCount > 0 && !isAtBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button size="sm" onClick={scrollToBottom} className="pointer-events-auto shadow">
            ↓ {unreadCount} new message{unreadCount > 1 ? "s" : ""}
          </Button>
        </div>
      )}
    </div>
  );
}

function MessageRow({ message }: { message: MessagePayload }) {
  const ts = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="px-4 py-2">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-sm">{message.authorName}</span>
        <span className="text-xs text-muted-foreground">@{message.authorUsername}</span>
        <span className="text-xs text-muted-foreground">{ts}</span>
      </div>
      <div className="whitespace-pre-wrap break-words text-sm">{message.body}</div>
    </div>
  );
}
