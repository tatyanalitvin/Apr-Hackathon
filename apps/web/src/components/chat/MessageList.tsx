// REQ-047: Virtualized message list with lazy older-page loading.
// REQ-048: Auto-scroll pin + "↓ N new messages" pill when user is scrolled up.
// REQ-110/111/112/113/114: Per-row Edit/Delete hover menu (author-only),
// inline edit form, (edited) timestamp marker, and tombstone rendering for
// soft-deleted messages. Wiring lives in this file; the mutate fetches and
// socket reconciliation live in RoomClient.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { AttachmentPayload, MessagePayload } from "@ai-herders/shared/protocol";
import { Button } from "@/components/ui/button";
import { AttachmentImage } from "@/components/chat/AttachmentImage";
import { AttachmentChip } from "@/components/chat/AttachmentChip";
import { MessageActions } from "@/components/chat/MessageActions";
import { EditMessageForm } from "@/components/chat/EditMessageForm";

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
  // Optional because legacy callers (tests, unused routes) still mount without
  // edit wiring. When undefined the row simply never shows actions, preserving
  // the pre-S2 behavior.
  currentUserId?: string;
  // REQ-212 — v3 §2.5.5. When role is owner/admin AND roomKind is 'group',
  // the row reveals Delete on other members' messages. DMs (roomKind='dm')
  // have no admin concept (v3 §2.5.1) — gate stays closed regardless of role.
  currentUserRole?: "owner" | "admin" | "member";
  roomKind?: "group" | "dm";
  onEditMessage?: (messageId: string, body: string) => Promise<void>;
  onDeleteMessage?: (messageId: string) => Promise<void>;
  // REQ-133 R13 — opens a reply target on the parent (RoomClient). When
  // undefined, MessageRow drops the Reply button (legacy callers).
  onReply?: (messageId: string, authorUsername: string) => void;
}

export function MessageList({
  messages,
  hasMoreOlder,
  onLoadOlder,
  firstItemIndex,
  onAtBottomChange,
  currentUserId,
  currentUserRole,
  roomKind,
  onEditMessage,
  onDeleteMessage,
  onReply,
}: MessageListProps) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
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

  const handleEditSave = useCallback(
    async (messageId: string, body: string) => {
      if (!onEditMessage) return;
      await onEditMessage(messageId, body);
      setEditingId((cur) => (cur === messageId ? null : cur));
    },
    [onEditMessage],
  );

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
        itemContent={(_index, message) => (
          <MessageRow
            message={message}
            currentUserId={currentUserId}
            currentUserRole={currentUserRole}
            roomKind={roomKind}
            isEditing={editingId === message.id}
            onStartEdit={() => setEditingId(message.id)}
            onCancelEdit={() => setEditingId(null)}
            onSaveEdit={(body) => handleEditSave(message.id, body)}
            onDelete={onDeleteMessage ? () => onDeleteMessage(message.id) : undefined}
            onReply={
              onReply
                ? () => onReply(message.id, message.authorUsername)
                : undefined
            }
          />
        )}
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

interface MessageRowProps {
  message: MessagePayload;
  currentUserId?: string;
  currentUserRole?: "owner" | "admin" | "member";
  roomKind?: "group" | "dm";
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (body: string) => Promise<void> | void;
  onDelete?: () => Promise<void> | void;
  onReply?: () => void;
}

function MessageRow({
  message,
  currentUserId,
  currentUserRole,
  roomKind,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  onReply,
}: MessageRowProps) {
  const ts = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const attachments = message.attachments ?? [];
  const isDeleted = Boolean(message.deletedAt);
  const isOwn = Boolean(currentUserId && message.authorId === currentUserId);
  // REQ-133 R13 — Reply is author-agnostic; Edit/Delete remain own-scoped
  // (REQ-110/112/114). Tombstones and in-flight edits suppress all.
  // REQ-212 — v3 §2.5.5 admin-delete: owners/admins of a GROUP room also
  // see Delete on other members' messages (Delete only, no Edit). DMs
  // lack an admin concept (v3 §2.5.1) → gate stays closed there.
  const isGroupAdmin =
    roomKind === "group" &&
    (currentUserRole === "owner" || currentUserRole === "admin");
  const canAdminDelete = isGroupAdmin && !isOwn;
  const showOwnerActions = isOwn && !isDeleted && !isEditing && Boolean(onDelete);
  const showAdminDelete = canAdminDelete && !isDeleted && !isEditing && Boolean(onDelete);
  const showReply = !isDeleted && !isEditing && Boolean(onReply);
  const showActions = showOwnerActions || showAdminDelete || showReply;
  // REQ-110 R14 — quoted-block above body when this message is a reply.
  // Parent soft-delete flips `replyTo.deletedAt` (R11 reducer) to swap the
  // text for `[deleted]` without mutating any other row's body.
  const reply = message.replyTo;
  const parentDeleted = Boolean(reply?.deletedAt);

  // REQ-113 tombstone — deleted messages render a greyed-out "[message deleted]"
  // placeholder with the author's name intact. No attachments, no actions.
  if (isDeleted) {
    return (
      <div className="px-4 py-2 opacity-60">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-sm">{message.authorName}</span>
          <span className="text-xs text-muted-foreground">@{message.authorUsername}</span>
          <span className="text-xs text-muted-foreground">{ts}</span>
        </div>
        <div className="italic text-sm text-muted-foreground" data-testid="message-tombstone">
          [message deleted]
        </div>
      </div>
    );
  }

  return (
    <div className="group px-4 py-2">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-sm">{message.authorName}</span>
        <span className="text-xs text-muted-foreground">@{message.authorUsername}</span>
        <span className="text-xs text-muted-foreground">{ts}</span>
        {/* REQ-111 — indicator that survives reloads (editedAt persists server-side). */}
        {message.editedAt ? (
          <span
            className="text-xs text-muted-foreground"
            title={`Edited ${new Date(message.editedAt).toLocaleString()}`}
            data-testid="message-edited-indicator"
          >
            (edited)
          </span>
        ) : null}
        {showActions ? (
          <div className="ml-auto">
            <MessageActions
              onEdit={showOwnerActions ? onStartEdit : undefined}
              onDelete={
                showOwnerActions || showAdminDelete
                  ? () => void onDelete?.()
                  : undefined
              }
              onReply={showReply ? onReply : undefined}
            />
          </div>
        ) : null}
      </div>
      {reply ? (
        <div
          data-testid="reply-quoted-block"
          className="mt-0.5 border-l-2 border-muted-foreground/30 pl-2 text-xs italic opacity-80"
        >
          {parentDeleted ? (
            <span className="text-muted-foreground">[deleted]</span>
          ) : (
            <span className="line-clamp-1">
              <span className="font-medium">{reply.authorUsername}</span>:{" "}
              {reply.text}
            </span>
          )}
        </div>
      ) : null}
      {isEditing ? (
        <EditMessageForm
          initialBody={message.body}
          onSave={onSaveEdit}
          onCancel={onCancelEdit}
        />
      ) : message.body ? (
        <div className="whitespace-pre-wrap break-words text-sm">{message.body}</div>
      ) : null}
      {!isEditing && attachments.length > 0 ? (
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
