import { describe, it, expect, vi } from "vitest";
import type {
  MessageNewEvent,
  MessageEditedEvent,
  MessageDeletedEvent,
  MessagePayload,
  HistorySliceResponse,
} from "@ai-herders/shared/protocol";
import {
  createWatermark,
  type FetchHistoryFn,
  type WatermarkEmit,
  type WatermarkMutationApply,
} from "./watermark";

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

// REQ-110/112 — edit/delete events route through the same serial queue as
// message.new. The watermark must backfill any missing new messages up to
// roomHeadSeq BEFORE invoking applyMutation, drop foreign-room events, and
// keep the QueueItem union in arrival order.
function mutEvt(
  seq: number,
  roomHeadSeq: number,
  kind: "edited" | "deleted" = "edited",
  roomId = "general",
): MessageEditedEvent | MessageDeletedEvent {
  if (kind === "edited") {
    return {
      type: "message.edited",
      roomId,
      seq: String(seq),
      roomHeadSeq: String(roomHeadSeq),
      messageId: `m-${seq}`,
      body: `edited ${seq}`,
      editedAt: new Date().toISOString(),
    };
  }
  return {
    type: "message.deleted",
    roomId,
    seq: String(seq),
    roomHeadSeq: String(roomHeadSeq),
    messageId: `m-${seq}`,
    deletedAt: new Date().toISOString(),
    deletedByRole: "author",
  };
}

describe("createWatermark mutations — REQ-110/112", () => {
  it("applies mutation immediately when already in sync (head <= lastSeen)", async () => {
    const emit = vi.fn<WatermarkEmit>();
    const fetchHistory = vi.fn<FetchHistoryFn>();
    const applyMutation = vi.fn<WatermarkMutationApply>();
    const w = createWatermark("general", fetchHistory, emit, applyMutation);
    w.primeFromAck("5");

    const m = mutEvt(3, 5, "edited");
    await w.ingestMutation(m);

    expect(fetchHistory).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(applyMutation).toHaveBeenCalledTimes(1);
    expect(applyMutation).toHaveBeenCalledWith(m);
  });

  it("drops mutations from other rooms", async () => {
    const emit = vi.fn<WatermarkEmit>();
    const fetchHistory = vi.fn<FetchHistoryFn>();
    const applyMutation = vi.fn<WatermarkMutationApply>();
    const w = createWatermark("general", fetchHistory, emit, applyMutation);
    w.primeFromAck("1");

    const m = mutEvt(2, 2, "deleted", "other-room");
    await w.ingestMutation(m);

    expect(emit).not.toHaveBeenCalled();
    expect(fetchHistory).not.toHaveBeenCalled();
    expect(applyMutation).not.toHaveBeenCalled();
  });

  it("backfills missing new messages up to roomHeadSeq BEFORE applying mutation", async () => {
    const callOrder: string[] = [];
    const emit = vi.fn<WatermarkEmit>((m) => {
      callOrder.push(`emit:${m.seq}`);
    });
    const fetchHistory = vi
      .fn<FetchHistoryFn>()
      .mockResolvedValue(slice([msg(2), msg(3), msg(4)], 2n, 4n, 4n));
    const applyMutation = vi.fn<WatermarkMutationApply>(() => {
      callOrder.push("apply");
    });
    const w = createWatermark("general", fetchHistory, emit, applyMutation);
    w.primeFromAck("1");

    // Edit event for seq=2; roomHeadSeq=4 means 3 new messages were missed.
    const m = mutEvt(2, 4, "edited");
    await w.ingestMutation(m);

    expect(fetchHistory).toHaveBeenCalledWith("general", 2n, 4n);
    expect(callOrder).toEqual(["emit:2", "emit:3", "emit:4", "apply"]);
    expect(applyMutation).toHaveBeenCalledWith(m);
    expect(w.getLastSeenSeq()).toBe(4n);
  });

  it("advances lastSeen to head and still applies when slice is empty despite a gap", async () => {
    const emit = vi.fn<WatermarkEmit>();
    const fetchHistory = vi
      .fn<FetchHistoryFn>()
      .mockResolvedValue(slice([], 2n, 4n, 4n));
    const applyMutation = vi.fn<WatermarkMutationApply>();
    const w = createWatermark("general", fetchHistory, emit, applyMutation);
    w.primeFromAck("1");

    const m = mutEvt(2, 4, "deleted");
    await w.ingestMutation(m);

    expect(fetchHistory).toHaveBeenCalledWith("general", 2n, 4n);
    expect(emit).not.toHaveBeenCalled();
    // head > lastSeen even though slice was empty → advance to head anyway.
    expect(w.getLastSeenSeq()).toBe(4n);
    expect(applyMutation).toHaveBeenCalledTimes(1);
    expect(applyMutation).toHaveBeenCalledWith(m);
  });

  it("queues items of both kinds and processes them in arrival order", async () => {
    const callOrder: string[] = [];
    const emit = vi.fn<WatermarkEmit>((m) => {
      callOrder.push(`emit:${m.seq}`);
    });
    const applyMutation = vi.fn<WatermarkMutationApply>((e) => {
      callOrder.push(`apply:${e.seq}`);
    });

    let resolveFirst!: (s: HistorySliceResponse) => void;
    const fetchHistory = vi.fn<FetchHistoryFn>().mockImplementation(
      (_r, from, to) =>
        new Promise<HistorySliceResponse>((res) => {
          // First call: a gap 2..2 for the ingest(evt(3)).
          if (from === 2n && to === 2n) {
            resolveFirst = res;
            return;
          }
          // Subsequent calls resolve synchronously.
          res(slice([], from, to, to));
        }),
    );

    const w = createWatermark("general", fetchHistory, emit, applyMutation);
    w.primeFromAck("1");

    // Kick off first ingest: backfill 2..2, then emit live 3. It suspends.
    const first = w.ingest(evt(3));
    // While busy, interleave a mutation then a new. Both must queue and
    // process in arrival order, after `first` finishes.
    const second = w.ingestMutation(mutEvt(3, 3, "edited")); // head=3 == lastSeen-after-first
    const third = w.ingest(evt(4));

    resolveFirst(slice([msg(2)], 2n, 2n, 3n));

    await Promise.all([first, second, third]);

    expect(callOrder).toEqual([
      "emit:2", // backfill from first
      "emit:3", // live from first
      "apply:3", // queued mutation (in sync, no fetch)
      "emit:4", // queued new (contiguous)
    ]);
    // fetchHistory should NOT have been called again after the initial 2..2
    // gap — the mutation's head was already reached, and evt(4) was contiguous.
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it("resolves without calling apply when applyMutation is not provided", async () => {
    const emit = vi.fn<WatermarkEmit>();
    const fetchHistory = vi
      .fn<FetchHistoryFn>()
      .mockResolvedValue(slice([msg(2)], 2n, 2n, 2n));
    // No applyMutation passed.
    const w = createWatermark("general", fetchHistory, emit);
    w.primeFromAck("1");

    // head=2 > lastSeen=1 → triggers backfill, then the missing apply step
    // must be a no-op, not a throw.
    await expect(w.ingestMutation(mutEvt(2, 2, "edited"))).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ seq: "2" }));
    expect(w.getLastSeenSeq()).toBe(2n);
  });

  it("reset() mid-backfill invalidates the stale mutation continuation (no emit, no apply)", async () => {
    const emit = vi.fn<WatermarkEmit>();
    const applyMutation = vi.fn<WatermarkMutationApply>();
    let resolveBackfill!: (s: HistorySliceResponse) => void;
    const fetchHistory = vi.fn<FetchHistoryFn>().mockImplementationOnce(
      () =>
        new Promise<HistorySliceResponse>((r) => {
          resolveBackfill = r;
        }),
    );

    const w = createWatermark("general", fetchHistory, emit, applyMutation);
    w.primeFromAck("1");

    const pending = w.ingestMutation(mutEvt(2, 5, "edited"));
    // Bump generation mid-flight — the in-flight backfill must become a no-op.
    w.reset();
    resolveBackfill(slice([msg(2), msg(3), msg(4), msg(5)], 2n, 5n, 5n));
    await pending.catch(() => {});

    expect(emit).not.toHaveBeenCalled();
    expect(applyMutation).not.toHaveBeenCalled();
    expect(w.getLastSeenSeq()).toBe(0n);
  });

  it("rejects and clears queue on fetchHistory error; follow-up ingest recovers", async () => {
    const emit = vi.fn<WatermarkEmit>();
    const applyMutation = vi.fn<WatermarkMutationApply>();
    const fetchHistory = vi
      .fn<FetchHistoryFn>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(slice([], 0n, 0n));

    const w = createWatermark("general", fetchHistory, emit, applyMutation);
    w.primeFromAck("1");

    await expect(w.ingestMutation(mutEvt(2, 5, "edited"))).rejects.toThrow("boom");

    // After error: no stranded queue, busy released, no apply.
    expect(applyMutation).not.toHaveBeenCalled();

    emit.mockClear();
    // Recover with a plain in-order new message — no backfill needed.
    await w.ingest(evt(2));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ seq: "2" }));
  });

  it("clears queue on error even when a mutation was queued behind the failing ingest", async () => {
    const emit = vi.fn<WatermarkEmit>();
    const applyMutation = vi.fn<WatermarkMutationApply>();
    let rejectFirst!: (err: Error) => void;
    const fetchHistory = vi
      .fn<FetchHistoryFn>()
      .mockImplementationOnce(
        () =>
          new Promise<HistorySliceResponse>((_res, rej) => {
            rejectFirst = rej;
          }),
      )
      .mockResolvedValueOnce(slice([], 0n, 0n));

    const w = createWatermark("general", fetchHistory, emit, applyMutation);
    w.primeFromAck("1");

    const first = w.ingest(evt(5)); // triggers backfill 2..4, suspends
    const queued = w.ingestMutation(mutEvt(5, 5, "edited")); // queues while busy

    rejectFirst(new Error("net"));

    await expect(first).rejects.toThrow("net");
    // Queued mutation was dropped as part of queue.length = 0 in finally.
    await expect(queued).resolves.toBeUndefined();
    expect(applyMutation).not.toHaveBeenCalled();

    // busy released → next ingest works.
    emit.mockClear();
    await w.ingest(evt(2));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ seq: "2" }));
  });

  it("delete variant flows through backfill-then-apply just like edit", async () => {
    const callOrder: string[] = [];
    const emit = vi.fn<WatermarkEmit>((m) => {
      callOrder.push(`emit:${m.seq}`);
    });
    const fetchHistory = vi
      .fn<FetchHistoryFn>()
      .mockResolvedValue(slice([msg(2), msg(3)], 2n, 3n, 3n));
    const applyMutation = vi.fn<WatermarkMutationApply>((e) => {
      callOrder.push(`apply:${e.type}:${e.messageId}`);
    });
    const w = createWatermark("general", fetchHistory, emit, applyMutation);
    w.primeFromAck("1");

    const m = mutEvt(2, 3, "deleted");
    await w.ingestMutation(m);

    expect(callOrder).toEqual(["emit:2", "emit:3", "apply:message.deleted:m-2"]);
    expect(applyMutation).toHaveBeenCalledWith(m);
    expect(w.getLastSeenSeq()).toBe(3n);
  });
});
