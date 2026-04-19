import { describe, it, expect, vi } from "vitest";
import type { MessageNewEvent, MessagePayload, HistorySliceResponse } from "@ai-herders/shared/protocol";
import { createWatermark, type FetchHistoryFn, type WatermarkEmit } from "./watermark";

function msg(seq: number): MessagePayload {
  return {
    id: `m-${seq}`,
    roomId: "general",
    authorId: "u",
    authorUsername: "u",
    authorName: "User",
    body: `msg ${seq}`,
    seq: String(seq),
    replyToId: null,
    replyTo: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date().toISOString(),
  };
}

function evt(seq: number, roomHeadSeq = seq): MessageNewEvent {
  return {
    type: "message.new",
    roomId: "general",
    seq: String(seq),
    roomHeadSeq: String(roomHeadSeq),
    message: msg(seq),
  };
}

function slice(
  messages: MessagePayload[],
  fromSeq: bigint | string,
  toSeq: bigint | string,
  roomHeadSeq: bigint | string = toSeq,
): HistorySliceResponse {
  return {
    roomId: "general",
    fromSeq: String(fromSeq),
    toSeq: String(toSeq),
    roomHeadSeq: String(roomHeadSeq),
    messages,
  };
}

describe("createWatermark (ADR-0003)", () => {
  it("emits in-order message directly", async () => {
    const emit = vi.fn();
    const fetchHistory = vi.fn();
    const wm = createWatermark("general", fetchHistory, emit);
    wm.primeFromAck("0");
    await wm.ingest(evt(1));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ seq: "1" }));
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  it("on a single-message gap, backfills then emits", async () => {
    const emit = vi.fn();
    const fetchHistory = vi.fn<(r: string, f: bigint, t: bigint) => Promise<HistorySliceResponse>>().mockResolvedValue(slice([msg(2)], "2", "2", "3"));
    const wm = createWatermark("general", fetchHistory, emit);
    wm.primeFromAck("1");
    await wm.ingest(evt(3));
    expect(fetchHistory).toHaveBeenCalledWith("general", 2n, 2n);
    expect(emit).toHaveBeenNthCalledWith(1, expect.objectContaining({ seq: "2" }));
    expect(emit).toHaveBeenNthCalledWith(2, expect.objectContaining({ seq: "3" }));
  });

  it("on a multi-message gap, backfills the range in ascending order", async () => {
    const emit = vi.fn();
    const fetchHistory = vi.fn().mockResolvedValue(slice([msg(2), msg(3), msg(4)], "2", "4", "5"));
    const wm = createWatermark("general", fetchHistory, emit);
    wm.primeFromAck("1");
    await wm.ingest(evt(5));
    expect(fetchHistory).toHaveBeenCalledWith("general", 2n, 4n);
    expect(emit.mock.calls.map((c) => c[0].seq)).toEqual(["2", "3", "4", "5"]);
  });

  it("drops duplicates (seq <= lastSeen)", async () => {
    const emit = vi.fn();
    const fetchHistory = vi.fn();
    const wm = createWatermark("general", fetchHistory, emit);
    wm.primeFromAck("5");
    await wm.ingest(evt(3));
    await wm.ingest(evt(5));
    expect(emit).not.toHaveBeenCalled();
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  it("serializes concurrent arrivals while backfill is in flight", async () => {
    const emit = vi.fn();
    let resolveBackfill!: (r: HistorySliceResponse) => void;
    const fetchHistory = vi.fn(() => new Promise<HistorySliceResponse>((r) => { resolveBackfill = r; }));
    const wm = createWatermark("general", fetchHistory, emit);
    wm.primeFromAck("1");

    const first = wm.ingest(evt(3));       // triggers backfill 2..2
    const concurrent = wm.ingest(evt(4));  // contiguous with first — must wait

    resolveBackfill(slice([msg(2)], "2", "2", "4"));
    await first;
    await concurrent;

    expect(emit.mock.calls.map((c) => c[0].seq)).toEqual(["2", "3", "4"]);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it("primes lastSeen from subscribe-ack", async () => {
    const emit = vi.fn();
    const fetchHistory = vi.fn();
    const wm = createWatermark("general", fetchHistory, emit);
    wm.primeFromAck("10");
    await wm.ingest(evt(11));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ seq: "11" }));
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  it("reset() returns the watermark to pre-ack state", async () => {
    const emit = vi.fn();
    const fetchHistory = vi.fn().mockResolvedValue(slice([], "1", "5", "6"));
    const wm = createWatermark("general", fetchHistory, emit);
    wm.primeFromAck("5");
    wm.reset();
    await wm.ingest(evt(6));
    expect(fetchHistory).toHaveBeenCalled();
  });

  it("recovers after fetchHistory rejects", async () => {
    const fetchHistory = vi.fn<FetchHistoryFn>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(slice([], 5n, 5n));
    const emit = vi.fn<WatermarkEmit>();
    const w = createWatermark("general", fetchHistory, emit);
    w.primeFromAck("1");

    // First ingest triggers backfill which rejects
    await expect(w.ingest(evt(5))).rejects.toThrow("transient");

    // Next ingest should recover — no stranded queue, busy released
    emit.mockClear();
    await w.ingest(evt(6));

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ seq: "6" }));
  });

  it("primeFromAck only advances forward", async () => {
    const fetchHistory = vi.fn<FetchHistoryFn>().mockResolvedValue(slice([], 0n, 0n));
    const emit = vi.fn<WatermarkEmit>();
    const w = createWatermark("general", fetchHistory, emit);

    w.primeFromAck("10");
    w.primeFromAck("5"); // lower — must be ignored

    await w.ingest(evt(11)); // lastSeen=10, evt.seq=11, no gap
    expect(fetchHistory).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ seq: "11" }));
  });

  it("reset() clears busy and queue mid-flight", async () => {
    let resolveBackfill: (s: HistorySliceResponse) => void = () => {};
    const fetchHistory = vi.fn<FetchHistoryFn>().mockImplementationOnce(
      () => new Promise<HistorySliceResponse>((r) => { resolveBackfill = r; }),
    );
    const emit = vi.fn<WatermarkEmit>();
    const w = createWatermark("general", fetchHistory, emit);
    w.primeFromAck("1");

    const pending = w.ingest(evt(5)); // triggers backfill, suspends
    w.reset();
    resolveBackfill(slice([msg(2), msg(3), msg(4)], 2n, 4n));
    await pending.catch(() => {}); // may resolve or reject — either is acceptable

    // After reset, state is clean: lastSeen=0, no busy, no queue
    expect(w.getLastSeenSeq()).toBe(0n);

    // Next ingest works fresh
    emit.mockClear();
    fetchHistory.mockResolvedValueOnce(slice([], 0n, 0n));
    await w.ingest(evt(1));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ seq: "1" }));
  });

  it("trims backfill messages at or above the live event's seq", async () => {
    const fetchHistory = vi.fn<FetchHistoryFn>().mockResolvedValue(
      slice([msg(2), msg(3), msg(4), msg(5)], 2n, 4n), // 5 is above window — must be dropped
    );
    const emit = vi.fn<WatermarkEmit>();
    const w = createWatermark("general", fetchHistory, emit);
    w.primeFromAck("1");

    await w.ingest(evt(5));

    const seqs = emit.mock.calls.map((c) => (c[0] as { seq: string }).seq);
    expect(seqs).toEqual(["2", "3", "4", "5"]); // live 5 emits once, from-slice 5 dropped
  });

  it("drops events from other rooms", async () => {
    const fetchHistory = vi.fn<FetchHistoryFn>();
    const emit = vi.fn<WatermarkEmit>();
    const w = createWatermark("general", fetchHistory, emit);
    w.primeFromAck("1");

    const wrong = evt(2);
    wrong.roomId = "other-room";
    await w.ingest(wrong);

    expect(emit).not.toHaveBeenCalled();
    expect(fetchHistory).not.toHaveBeenCalled();
  });
});
