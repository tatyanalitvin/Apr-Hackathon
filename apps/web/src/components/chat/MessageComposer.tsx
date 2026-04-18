"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { Button } from "@/components/ui/button";
import { readDraft, writeDraft, clearDraft } from "@/lib/composer-draft";

const MAX_BYTES = 3072;
const SOFT_WARN_BYTES = 2800;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

export interface MessageComposerProps {
  userId: string;
  roomId: string;
  onSend: (body: string) => Promise<void> | void;
  disabled?: boolean;
}

export function MessageComposer({ userId, roomId, onSend, disabled }: MessageComposerProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendingRef = useRef(false);

  // Hydrate draft on mount / when userId or roomId changes.
  useEffect(() => {
    setValue(readDraft(userId, roomId));
  }, [userId, roomId]);

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
  const canSend = !sending && !disabled && trimmed.length > 0 && !overLimit;

  const send = useCallback(async () => {
    if (sendingRef.current) return;
    if (!canSend) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const body = trimmed.normalize("NFC");
      try {
        await onSend(body);
      } catch {
        // Parent owns error surfacing; keep draft intact so user can retry.
        return;
      }
      setValue("");
      clearDraft(userId, roomId);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [canSend, trimmed, onSend, userId, roomId]);

  return (
    <div className="border-t p-3 space-y-1">
      <TextareaAutosize
        aria-label="Message"
        className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="Message #room"
        minRows={1}
        maxRows={6}
        value={value}
        disabled={disabled || sending}
        onChange={(e) => setValue(e.target.value)}
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
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
