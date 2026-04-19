// REQ-047: Virtualized message list with lazy older-page loading.
// REQ-048: Auto-scroll pin + "↓ N new messages" pill when user is scrolled up.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { AttachmentPayload, MessagePayload } from "@ai-herders/shared/protocol";
import { Button } from "@/components/ui/button";
import { AttachmentImage } from "@/components/chat/AttachmentImage";
import { AttachmentChip } from "@/components/chat/AttachmentChip";

const IMAGE_MIME_RE = /^image\/(png|jpe?g|gif|webp)$/i;

function isImage(att: AttachmentPayload): boolean {
  return IMAGE_MIME_RE.test(att.mimeType);
}

export interface MessageListProps {
  messages: MessagePayload[];
  hasMoreOlder: boolean;
  onLoadOlder: () => Promise<void> | void;
  firstItemIndex: number;
  // REQ-120 — parent needs the at-bottom signal to gate mark-read. Optional
  // so older callers (e.g. DM views) don't have to thread it.
  onAtBottomChange?: (atBottom: boolean) => void;
}

export function MessageList({ messages, hasMoreOlder, onLoadOlder, firstItemIndex, onAtBottomChange }: MessageListProps) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const lastMessageCountRef = useRef(messages.length);
  const lastFirstIndexRef = useRef(firstItemIndex);
  const ref = useRef<VirtuosoHandle>(null);

  // Only *appended* messages count as unread — prepended older-page loads
  // shift firstItemIndex down (Virtuoso contract) and must not inflate the pill.
  useEffect(() => {
    const totalDelta = messages.length - lastMessageCountRef.current;
    const prependedDelta = lastFirstIndexRef.current - firstItemIndex;
    const appendedDelta = totalDelta - prependedDelta;
    if (appendedDelta > 0 && !isAtBottom) setUnreadCount((n) => n + appendedDelta);
    lastMessageCountRef.current = messages.length;
    lastFirstIndexRef.current = firstItemIndex;
  }, [messages.length, firstItemIndex, isAtBottom]);

  const handleAtBottomStateChange = useCallback(
    (atBottom: boolean) => {
      setIsAtBottom(atBottom);
      if (atBottom) setUnreadCount(0);
      onAtBottomChange?.(atBottom);
    },
    [onAtBottomChange],
  );

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
  const attachments = message.attachments ?? [];
  return (
    <div className="px-4 py-2">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-sm">{message.authorName}</span>
        <span className="text-xs text-muted-foreground">@{message.authorUsername}</span>
        <span className="text-xs text-muted-foreground">{ts}</span>
      </div>
      {message.body ? (
        <div className="whitespace-pre-wrap break-words text-sm">{message.body}</div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="mt-1 flex flex-col gap-2">
          {attachments.map((att) =>
            isImage(att) ? (
              <AttachmentImage key={att.id} attachment={att} />
            ) : (
              <AttachmentChip key={att.id} attachment={att} />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
