"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { EmojiPickerButton } from "@/components/emoji/EmojiPickerButton";
import { readDraft, writeDraft, clearDraft } from "@/lib/composer-draft";

const MAX_BYTES = 3072;
const SOFT_WARN_BYTES = 2800;

// Client-side caps mirror backend s2-attachments.md R7/R8. Pre-validation
// saves an upload round-trip and matches the server 413 for a consistent UX.
const FILE_CAP_BYTES = 20 * 1024 * 1024;
const IMAGE_CAP_BYTES = 3 * 1024 * 1024;
const ACCEPTED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

function validateFile(file: File): string | null {
  const isImageMime = file.type.startsWith("image/");
  if (isImageMime) {
    if (!ACCEPTED_IMAGE_MIMES.has(file.type)) {
      return `Unsupported image type: ${file.type || "unknown"}`;
    }
    if (file.size > IMAGE_CAP_BYTES) {
      return `Image too large (max ${IMAGE_CAP_BYTES / (1024 * 1024)} MB)`;
    }
  }
  if (file.size > FILE_CAP_BYTES) {
    return `File too large (max ${FILE_CAP_BYTES / (1024 * 1024)} MB)`;
  }
  return null;
}

interface PendingAttachment {
  localId: string;
  file: File;
  status: "uploading" | "uploaded" | "error";
  attachmentId?: string;
  error?: string;
}

export interface MessageComposerProps {
  userId: string;
  roomId: string;
  roomName?: string;
  onSend: (
    body: string,
    attachmentIds?: string[],
    replyToId?: string,
  ) => Promise<void> | void;
  // REQ-E-UI-COMPOSER-COMMENT — `options.comment` carries the batch-scoped
  // caption to the backend multipart field. Result keeps its S1 shape
  // (`attachmentId` only) so existing mocks stay compatible; the post-NFC
  // echo (REQ-E-UPLOAD-RESP) is observed by RoomClient on the wider
  // `UploadAttachmentResult` it forwards from chat-api.
  onUpload?: (
    file: File,
    options?: { comment?: string },
  ) => Promise<{ attachmentId: string }>;
  disabled?: boolean;
  // REQ-133 R12 — reply chip. When the parent (RoomClient) records an active
  // reply target, pass it here to render the chip above the textarea and
  // carry `replyToId` into the next `onSend` call.
  replyTo?: { messageId: string; authorUsername: string } | null;
  onClearReply?: () => void;
}

export function MessageComposer({
  userId,
  roomId,
  roomName,
  onSend,
  onUpload,
  disabled,
  replyTo,
  onClearReply,
}: MessageComposerProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  // REQ-E-UI-COMPOSER-COMMENT — one caption per upload batch (matches
  // §2.6.3 phrasing and the composer's pending.map layout).
  const [comment, setComment] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Source-of-truth for what the user most recently typed. Decoupled from
  // React state because under rapid burst + parent re-render (socket echo)
  // racing with onChange, React can commit a render with stale `value=""`
  // and reset the controlled textarea's DOM value — losing the keystroke
  // even though onChange fired. Updating this ref synchronously in onChange
  // means send() always reads the latest user input.
  const latestValueRef = useRef("");
  // Rapid Enter presses while a previous send is in flight get queued here
  // and drained serially in send()'s finally. Without this, the
  // `sendingRef` guard silently dropped back-to-back messages — see
  // FINDINGS.md EDGE/ rapid burst finding.
  const queueRef = useRef<
    Array<{ body: string; attachmentIds: string[]; replyToId: string | undefined }>
  >([]);
  // REQ-213 — v3 §2.6.2 explicit attach affordance. Hidden native input is
  // trampolined by the visible Paperclip button; selected files route through
  // the existing uploadFiles() path (same as drop / paste) so no new upload
  // state machine is needed.
  const attachInputRef = useRef<HTMLInputElement>(null);

  // Hydrate draft on mount / when userId or roomId changes.
  useEffect(() => {
    const draft = readDraft(userId, roomId);
    latestValueRef.current = draft;
    setValue(draft);
  }, [userId, roomId]);

  // Resize the textarea whenever value changes programmatically (draft
  // hydration, insertAtCaret, setValue("") on send). Covers insertAtCaret too
  // so a separate post-RAF resize is not needed.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [value]);

  // Pending uploads are scoped to the current room — swap rooms, drop state.
  useEffect(() => {
    setPending([]);
    setUploadError(null);
    setComment("");
  }, [roomId]);

  // Debounced draft persistence.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      writeDraft(userId, roomId, value);
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, userId, roomId]);

  const trimmed = value.trim();
  const bytes = useMemo(() => byteLength(value), [value]);
  const overLimit = bytes > MAX_BYTES;

  const readyAttachmentIds = pending
    .filter((p) => p.status === "uploaded" && p.attachmentId)
    .map((p) => p.attachmentId!);
  const anyUploading = pending.some((p) => p.status === "uploading");

  const hasContent = trimmed.length > 0 || readyAttachmentIds.length > 0;
  // `canEnqueue` drops the `!sending` gate so rapid Enters queue onto the
  // in-flight send rather than being dropped. `canSend` keeps `!sending`
  // because the button + first-send path still want the classic gate.
  const canEnqueue = !disabled && !anyUploading && hasContent && !overLimit;
  const canSend = !sending && canEnqueue;

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!onUpload || files.length === 0) return;
      setUploadError(null);
      const newPending: PendingAttachment[] = [];
      for (const file of files) {
        const reason = validateFile(file);
        if (reason) {
          setUploadError(`${file.name}: ${reason}`);
          continue;
        }
        newPending.push({
          localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file,
          status: "uploading",
        });
      }
      if (newPending.length === 0) return;
      setPending((prev) => [...prev, ...newPending]);
      // Snapshot the caption at dispatch time so a mid-flight edit doesn't
      // desync what the user saw vs. what the server stored. Omitted entirely
      // when empty — keeps the single-arg call the legacy mock tests assert on.
      // The backend treats "no comment" and empty-string as NULL (REQ-082).
      const captionAtDispatch = comment.length > 0 ? comment : undefined;
      await Promise.all(
        newPending.map(async (p) => {
          try {
            const { attachmentId } = captionAtDispatch === undefined
              ? await onUpload(p.file)
              : await onUpload(p.file, { comment: captionAtDispatch });
            setPending((prev) =>
              prev.map((x) =>
                x.localId === p.localId
                  ? { ...x, status: "uploaded", attachmentId }
                  : x,
              ),
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : "upload failed";
            setPending((prev) =>
              prev.map((x) =>
                x.localId === p.localId ? { ...x, status: "error", error: msg } : x,
              ),
            );
            setUploadError(`${p.file.name}: ${msg}`);
          }
        }),
      );
    },
    [onUpload, comment],
  );

  const send = useCallback(async () => {
    // Read the latest typed value via ref, not React state or the textarea
    // DOM. Under rapid Enter bursts, a parent re-render (e.g. a socket echo
    // adding a message to the list) can commit with our pending setValue
    // unflushed, briefly resetting the controlled textarea's DOM to "" —
    // even though onChange already fired with the new text. The ref
    // captures every keystroke synchronously, so send() never misses one.
    const currentValue =
      latestValueRef.current || textareaRef.current?.value || value;
    const currentTrimmed = currentValue.trim();
    const hasContentNow =
      currentTrimmed.length > 0 || readyAttachmentIds.length > 0;
    const canEnqueueNow =
      !disabled && !anyUploading && hasContentNow && !overLimit;

    // If a previous send is still in flight, snapshot THIS message onto
    // the queue and clear the composer so the user can keep typing. The
    // in-flight send's finally drains the queue serially.
    if (sendingRef.current) {
      if (!canEnqueueNow) return;
      const attachmentIds = readyAttachmentIds;
      const body = (currentTrimmed.length === 0 && attachmentIds.length > 0
        ? "📎"
        : currentTrimmed
      ).normalize("NFC");
      queueRef.current.push({
        body,
        attachmentIds,
        replyToId: replyTo?.messageId,
      });
      // Only clear the ref if the user hasn't typed something newer since
      // onChange captured `body`. Otherwise we'd clobber the next keystroke.
      if (latestValueRef.current === currentValue) latestValueRef.current = "";
      setValue("");
      setPending([]);
      setComment("");
      setUploadError(null);
      clearDraft(userId, roomId);
      if (replyTo && onClearReply) onClearReply();
      return;
    }
    if (!canEnqueueNow || sending) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const attachmentIds = readyAttachmentIds;
      // Backend messageBodySchema requires body.min(1); when the user drags a
      // file without typing, we fall back to a glyph so the send isn't rejected.
      const body = (currentTrimmed.length === 0 && attachmentIds.length > 0
        ? "📎"
        : currentTrimmed
      ).normalize("NFC");
      try {
        // REQ-133 R12 — replyToId flows through as the 3rd positional arg.
        // Non-reply sends pass `undefined`, preserving the S1 2-arg signature
        // at the network layer (no `reply_to_id` key emitted server-side).
        const replyToId = replyTo?.messageId;
        if (attachmentIds.length > 0) {
          await onSend(body, attachmentIds, replyToId);
        } else {
          await onSend(body, undefined, replyToId);
        }
      } catch {
        // Parent owns error surfacing; keep draft intact so user can retry.
        return;
      }
      // Conditional clear: if the user has typed MORE text since we captured
      // `currentValue`, leave the ref alone so the next send() can pick it up.
      // Without this, rapid-burst onSend resolves can wipe an already-typed
      // message before its Enter keydown runs, silently dropping it.
      if (latestValueRef.current === currentValue) latestValueRef.current = "";
      setValue("");
      setPending([]);
      setComment("");
      setUploadError(null);
      clearDraft(userId, roomId);
      // Clear the reply target after a successful send. Parent owns state,
      // so ask it to drop the chip — `onClearReply` is optional because
      // legacy composer callers don't supply reply props at all.
      if (replyTo && onClearReply) onClearReply();
    } finally {
      // Drain any messages that the user queued by pressing Enter while
      // this send was in flight. If any one fails, RoomClient's existing
      // catch surfaces a toast (429 etc.) — we swallow here so one bad
      // message doesn't block the rest of the queue.
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift();
        if (!next) break;
        try {
          if (next.attachmentIds.length > 0) {
            await onSend(next.body, next.attachmentIds, next.replyToId);
          } else {
            await onSend(next.body, undefined, next.replyToId);
          }
        } catch {
          /* surfaced by parent via toast */
        }
      }
      sendingRef.current = false;
      setSending(false);
    }
  }, [
    value,
    sending,
    disabled,
    anyUploading,
    overLimit,
    readyAttachmentIds,
    onSend,
    userId,
    roomId,
    replyTo,
    onClearReply,
  ]);

  const removePending = useCallback((localId: string) => {
    setPending((prev) => prev.filter((p) => p.localId !== localId));
  }, []);

  // §2.5.2 R5 — splice the emoji at the textarea's current selection instead
  // of appending. Preserves caret position relative to the inserted glyph so
  // the user can keep typing mid-sentence. Falls back to append when the ref
  // isn't mounted (e.g. picker opened before first focus — rare but cheap).
  const insertAtCaret = useCallback((emoji: string) => {
    const el = textareaRef.current;
    if (!el) {
      setValue((v) => {
        const next = v + emoji;
        latestValueRef.current = next;
        return next;
      });
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    setValue((v) => {
      const next = v.slice(0, start) + emoji + v.slice(end);
      latestValueRef.current = next;
      return next;
    });
    // Restore focus + place caret after the inserted emoji on the next tick,
    // once React has flushed the new value back to the DOM.
    requestAnimationFrame(() => {
      const next = start + emoji.length;
      el.focus();
      el.setSelectionRange(next, next);
    });
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLFormElement>) => {
      e.preventDefault();
      setDragging(false);
      if (disabled || !onUpload) return;
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length > 0) void uploadFiles(files);
    },
    [uploadFiles, disabled, onUpload],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent<HTMLFormElement>) => {
      if (disabled || !onUpload) return;
      // Only treat drag events that actually carry files — ignore text selections etc.
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
        setDragging(true);
      }
    },
    [disabled, onUpload],
  );

  const onDragLeave = useCallback((e: React.DragEvent<HTMLFormElement>) => {
    // Only clear when leaving the root element (not a child).
    if (e.currentTarget === e.target) setDragging(false);
  }, []);

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled || !onUpload) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        void uploadFiles(files);
      }
    },
    [uploadFiles, disabled, onUpload],
  );

  return (
    <form
      aria-label="Message composer"
      className={`space-y-1 relative ${dragging ? "bg-accent/40 rounded-md" : ""}`}
      onSubmit={(e) => { e.preventDefault(); void send(); }}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center border-2 border-dashed border-primary/60 rounded-md text-sm text-primary bg-background/80">
          Drop to attach
        </div>
      ) : null}

      {/* AGENT-E: attachment preview zone */}
      {pending.length > 0 ? (
        <div className="flex flex-wrap gap-2 pb-1">
          {pending.map((p) => (
            <div
              key={p.localId}
              className={`flex items-center gap-2 rounded border px-2 py-1 text-xs ${
                p.status === "error"
                  ? "border-destructive/50 bg-destructive/10 text-destructive"
                  : "bg-muted/40"
              }`}
            >
              {p.status === "uploading" ? <span aria-hidden className="animate-pulse">…</span> : null}
              {p.status === "uploaded" ? <span aria-hidden>✓</span> : null}
              {p.status === "error" ? <span aria-hidden>⚠</span> : null}
              <span className="max-w-[12rem] truncate">{p.file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${p.file.name}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => removePending(p.localId)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {/* REQ-E-UI-COMPOSER-COMMENT — batch-scoped caption input.
          maxLength mirrors backend REQ-082 (500). Only rendered while at least
          one attachment is pending so it never clutters a text-only compose. */}
      {pending.length > 0 ? (
        <input
          type="text"
          aria-label="Attachment comment"
          data-testid="attachment-comment-input"
          placeholder="Add a comment (optional)"
          value={comment}
          maxLength={500}
          disabled={disabled || sending}
          onChange={(e) => setComment(e.target.value)}
          className="w-full rounded-md border bg-background px-3 py-1.5 text-xs outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : null}

      {uploadError ? (
        <div role="alert" className="text-xs text-destructive pb-1">
          {uploadError}
        </div>
      ) : null}

      {overLimit ? (
        <div role="alert" className="text-xs text-destructive pb-1">
          Message too long — max {MAX_BYTES.toLocaleString()} bytes.
        </div>
      ) : null}

      {replyTo ? (
        <div
          data-testid="reply-chip"
          className="flex items-center gap-2 rounded bg-muted/40 px-2 py-1 text-xs"
        >
          <span className="text-muted-foreground">
            Replying to{" "}
            <span className="font-medium text-foreground">
              {replyTo.authorUsername}
            </span>
          </span>
          {onClearReply ? (
            <button
              type="button"
              aria-label="Cancel reply"
              data-testid="reply-chip-clear"
              className="ml-auto rounded px-1 text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground"
              onClick={onClearReply}
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}

      <Textarea
        ref={textareaRef}
        aria-label="Message"
        placeholder={`Write to #${roomName || roomId}…`}
        rows={1}
        className="font-display italic resize-none max-h-[9rem] overflow-y-auto min-h-0"
        value={value}
        // UX-02 — don't flip `disabled` on `sending`. The browser blurs
        // disabled form controls, which broke "focus stays on the composer
        // after Enter". `sendingRef` still guards against double-submit on
        // the code path; the user just gets to keep typing mid-flight.
        disabled={disabled}
        onChange={(e) => {
          latestValueRef.current = e.target.value;
          setValue(e.target.value);
        }}
        onInput={(e) => {
          const el = e.currentTarget;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
        }}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="flex items-center justify-between">
        {/* AGENT-F: emoji zone — left cluster pairs the bytes counter with the
            emoji trigger so Send can stay flush-right under justify-between. */}
        <div className="flex items-center gap-2">
          <span
            className={`text-xs ${overLimit ? "text-destructive" : bytes >= SOFT_WARN_BYTES ? "text-amber-600" : "text-transparent"}`}
            aria-live="polite"
            aria-hidden={bytes < SOFT_WARN_BYTES}
          >
            {bytes} / {MAX_BYTES}
          </span>
          {onUpload ? (
            <>
              <input
                ref={attachInputRef}
                type="file"
                multiple
                data-testid="attach-file-input"
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length > 0) void uploadFiles(files);
                  // Reset so picking the same file twice still fires `change`.
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label="Attach files"
                data-testid="attach-button"
                disabled={disabled || sending}
                onClick={() => attachInputRef.current?.click()}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                📎
              </button>
            </>
          ) : null}
          <EmojiPickerButton
            onPick={insertAtCaret}
            disabled={disabled || sending}
          />
        </div>
        <Button type="submit" size="sm" disabled={!canSend}>
          {sending ? "Sending…" : anyUploading ? "Uploading…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
