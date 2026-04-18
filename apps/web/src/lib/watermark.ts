import type { MessageNewEvent, MessagePayload, HistorySliceResponse } from "@ai-herders/shared/protocol";

export type FetchHistoryFn = (
  roomId: string,
  fromSeq: bigint,
  toSeq: bigint,
) => Promise<HistorySliceResponse>;

export type WatermarkEmit = (message: MessagePayload) => void;

export interface Watermark {
  primeFromAck(headSeq: string): void;
  ingest(evt: MessageNewEvent): Promise<void>;
  reset(): void;
  getLastSeenSeq(): bigint;
}

/**
 * ADR-0003 client-side watermark gap-detection.
 *
 * Contract: every `message.new` must satisfy `evt.seq === lastSeenSeq + 1`.
 * Otherwise the client fetches the missing range via history, emits the
 * backfill in order, then emits the live message, then advances lastSeenSeq.
 *
 * Backfills are serialized behind a `busy` flag; concurrent events queue.
 * All comparisons use BigInt. Never `Number(seq)`.
 */
export function createWatermark(
  roomId: string,
  fetchHistory: FetchHistoryFn,
  emit: WatermarkEmit,
): Watermark {
  let lastSeenSeq = 0n;
  let busy = false;
  let generation = 0; // bumped on reset; in-flight backfills become no-ops
  const queue: MessageNewEvent[] = [];

  async function processEvent(evt: MessageNewEvent): Promise<void> {
    const gen = generation;
    const seq = BigInt(evt.seq);

    if (seq <= lastSeenSeq) return;

    if (seq === lastSeenSeq + 1n) {
      emit(evt.message);
      lastSeenSeq = seq;
      return;
    }

    const fromSeq = lastSeenSeq + 1n;
    const toSeq = seq - 1n;
    const slice = await fetchHistory(roomId, fromSeq, toSeq);
    // reset() while awaiting fetchHistory invalidates this backfill.
    if (generation !== gen) return;
    const sorted = [...slice.messages].sort((a, b) => {
      const av = BigInt(a.seq);
      const bv = BigInt(b.seq);
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    for (const m of sorted) {
      const ms = BigInt(m.seq);
      // Trim backfill to the requested window: drop anything already seen
      // and anything at/above the live event (we emit live below).
      if (ms <= lastSeenSeq) continue;
      if (ms >= seq) continue;
      emit(m);
      lastSeenSeq = ms;
    }
    // If the server returns an empty slice despite a real gap, we accept the
    // live event and advance; the server is the source of truth for seq
    // continuity. S1 scope — no retry.
    if (seq > lastSeenSeq) {
      emit(evt.message);
      lastSeenSeq = seq;
    }
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const next = queue.shift()!;
      await processEvent(next);
    }
  }

  async function ingest(evt: MessageNewEvent): Promise<void> {
    // Drop events mis-routed from other rooms.
    if (evt.roomId !== roomId) return;
    if (busy) {
      queue.push(evt);
      return;
    }
    busy = true;
    try {
      await processEvent(evt);
      await drain();
    } finally {
      // On error (from processEvent or drain) we clear the queue: favor
      // "stop emitting ghosts" over "strand the queue and freeze future emits".
      queue.length = 0;
      busy = false;
    }
  }

  return {
    primeFromAck(headSeq: string) {
      // Monotonic: prime only advances the watermark forward.
      const head = BigInt(headSeq);
      if (head > lastSeenSeq) lastSeenSeq = head;
    },
    ingest,
    reset() {
      // Caller must ensure no in-flight fetches — reset abandons any pending backfill.
      lastSeenSeq = 0n;
      busy = false;
      queue.length = 0;
      generation += 1;
    },
    getLastSeenSeq() {
      return lastSeenSeq;
    },
  };
}
