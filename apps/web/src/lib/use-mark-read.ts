// REQ-120 — debounced mark-read side-effect. Fires POST /rooms/:id/read with
// the caller's current `roomHeadSeq` when:
//   - the room is open, the tab is focused, and the message list is at the
//     bottom (scroll-locked); OR
//   - a new message arrives under those same conditions.
//
// Debounced 500ms so a burst of arrivals collapses into one POST. We always
// send the freshest observed seq — older calls in the batch are dropped.
//
// Server trusts client-computed seq per brief §3 pre-resolved Q2.

"use client";

import { useCallback, useEffect, useRef } from "react";
import { createChatApi } from "@/lib/socket";

const DEBOUNCE_MS = 500;

export interface UseMarkReadOptions {
  roomId: string;
  // Latest known head seq for this room (bigint or stringified bigint).
  headSeq: bigint | string | undefined | null;
  // True when the tab is focused AND the message list is at the bottom.
  // The caller composes this from document.visibilityState + a scroll-lock
  // flag on the Virtuoso list.
  canMarkRead: boolean;
  // Callback invoked with the seq that was just acked, so the caller can
  // update its local /rooms/me cache without a refetch.
  onMarked?: (lastReadSeq: bigint) => void;
}

export function useMarkRead({ roomId, headSeq, canMarkRead, onMarked }: UseMarkReadOptions) {
  // Last seq we've asked the server to persist — avoids re-POSTing identical
  // watermarks on every render cycle.
  const lastSentRef = useRef<bigint>(0n);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(
    async (seq: bigint) => {
      if (seq <= lastSentRef.current) return;
      lastSentRef.current = seq;
      try {
        const api = createChatApi();
        const res = await api.markRoomRead(roomId, seq);
        onMarked?.(BigInt(res.lastReadSeq));
      } catch {
        // Non-fatal — server will re-observe the state on the next call.
        // Roll back lastSentRef so a retry can happen.
        if (lastSentRef.current === seq) lastSentRef.current = 0n;
      }
    },
    [roomId, onMarked],
  );

  useEffect(() => {
    if (!canMarkRead) return;
    const parsed = parseSeq(headSeq);
    if (parsed <= 0n) return;
    if (parsed <= lastSentRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush(parsed);
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [canMarkRead, headSeq, flush]);

  // Reset the "last sent" gate when the room changes so re-entering a room
  // will POST again once conditions are met (the server is idempotent, but
  // we still want the local cache refresh on re-open).
  useEffect(() => {
    lastSentRef.current = 0n;
  }, [roomId]);
}

function parseSeq(v: bigint | string | undefined | null): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === "bigint") return v;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}
