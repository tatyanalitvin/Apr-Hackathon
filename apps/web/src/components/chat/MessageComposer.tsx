"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { Button } from "@/components/ui/button";
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
  onSend: (body: string, attachmentIds?: string[]) => Promise<void> | void;
  onUpload?: (file: File) => Promise<{ attachmentId: string }>;
  disabled?: boolean;
}

export function MessageComposer({ userId, roomId, onSend, onUpload, disabled }: MessageComposerProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendingRef = useRef(false);

  // Hydrate draft on mount / when userId or roomId changes.
  useEffect(() => {
    setValue(readDraft(userId, roomId));
  }, [userId, roomId]);

  // Pending uploads are scoped to the current room — swap rooms, drop state.
  useEffect(() => {
    setPending([]);
    setUploadError(null);
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
  const canSend = !sending && !disabled && !anyUploading && hasContent && !overLimit;

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
      await Promise.all(
        newPending.map(async (p) => {
          try {
            const { attachmentId } = await onUpload(p.file);
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
    [onUpload],
  );

  const send = useCallback(async () => {
    if (sendingRef.current) return;
    if (!canSend) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const attachmentIds = readyAttachmentIds;
      // Backend messageBodySchema requires body.min(1); when the user drags a
      // file without typing, we fall back to a glyph so the send isn't rejected.
      const body = (trimmed.length === 0 && attachmentIds.length > 0
        ? "📎"
        : trimmed
      ).normalize("NFC");
      try {
        if (attachmentIds.length > 0) {
          await onSend(body, attachmentIds);
        } else {
          await onSend(body);
        }
      } catch {
        // Parent owns error surfacing; keep draft intact so user can retry.
        return;
      }
      setValue("");
      setPending([]);
      setUploadError(null);
      clearDraft(userId, roomId);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [canSend, trimmed, readyAttachmentIds, onSend, userId, roomId]);

  const removePending = useCallback((localId: string) => {
    setPending((prev) => prev.filter((p) => p.localId !== localId));
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      if (disabled || !onUpload) return;
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length > 0) void uploadFiles(files);
    },
    [uploadFiles, disabled, onUpload],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (disabled || !onUpload) return;
      // Only treat drag events that actually carry files — ignore text selections etc.
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
        setDragging(true);
      }
    },
    [disabled, onUpload],
  );

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
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
    <div
      className={`border-t p-3 space-y-1 relative ${dragging ? "bg-accent/40" : ""}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center border-2 border-dashed border-primary/60 rounded-md text-sm text-primary bg-background/80">
          Drop to attach
        </div>
      ) : null}

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

      {uploadError ? (
        <div role="alert" className="text-xs text-destructive pb-1">
          {uploadError}
        </div>
      ) : null}

      <TextareaAutosize
        aria-label="Message"
        className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
        placeholder={`Message #${roomId}`}
        minRows={1}
        maxRows={6}
        value={value}
        disabled={disabled || sending}
        onChange={(e) => setValue(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="flex items-center justify-between">
        <span
          className={`text-xs ${overLimit ? "text-destructive" : bytes >= SOFT_WARN_BYTES ? "text-amber-600" : "text-transparent"}`}
          aria-live="polite"
          aria-hidden={bytes < SOFT_WARN_BYTES}
        >
          {bytes} / {MAX_BYTES}
        </span>
        <Button size="sm" onClick={() => void send()} disabled={!canSend}>
          {sending ? "Sending…" : anyUploading ? "Uploading…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
