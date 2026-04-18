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
  const queue: MessageNewEvent[] = [];

  async function processEvent(evt: MessageNewEvent): Promise<void> {
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
    const sorted = [...slice.messages].sort((a, b) => {
      const av = BigInt(a.seq);
      const bv = BigInt(b.seq);
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    for (const m of sorted) {
      const ms = BigInt(m.seq);
      if (ms <= lastSeenSeq) continue;
      emit(m);
      lastSeenSeq = ms;
    }
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
    if (busy) {
      queue.push(evt);
      return;
    }
    busy = true;
    try {
      await processEvent(evt);
      await drain();
    } finally {
      busy = false;
    }
  }

  return {
    primeFromAck(headSeq: string) {
      lastSeenSeq = BigInt(headSeq);
    },
    ingest,
    reset() {
      lastSeenSeq = 0n;
      queue.length = 0;
    },
    getLastSeenSeq() {
      return lastSeenSeq;
    },
  };
}
