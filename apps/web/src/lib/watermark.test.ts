import { describe, it, expect, vi } from "vitest";
import type { MessageNewEvent, MessagePayload, HistorySliceResponse } from "@ai-herders/shared/protocol";
import { createWatermark } from "./watermark";

function msg(seq: number, roomHeadSeq = seq): MessagePayload {
  return {
    id: `m-${seq}`,
    roomId: "general",
    authorId: "u",
    body: `msg ${seq}`,
    seq: String(seq),
    roomHeadSeq: String(roomHeadSeq),
    replyToId: null,
    editedAt: null,
    createdAt: new Date().toISOString(),
  } as unknown as MessagePayload;
}

function evt(seq: number, roomHeadSeq = seq): MessageNewEvent {
  return {
    type: "message.new",
    roomId: "general",
    seq: String(seq),
    roomHeadSeq: String(roomHeadSeq),
    message: msg(seq, roomHeadSeq),
  } as MessageNewEvent;
}

function slice(messages: MessagePayload[], fromSeq: string, toSeq: string, roomHeadSeq: string): HistorySliceResponse {
  return {
    roomId: "general",
    fromSeq,
    toSeq,
    roomHeadSeq,
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
});
