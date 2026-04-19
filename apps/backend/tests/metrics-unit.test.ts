// REQ-158 — admin metrics ring-buffer math.
//
// These are pure unit tests: no fastify, no sockets, no redis. They lock
// down the algebra of the in-memory counters so the integration tests below
// can assume the primitives work. Time is injected explicitly so nothing
// flakes on timer resolution.
//
// Design notes:
//   - messagesPerMinute is 12 buckets × 5s, oldest first. `record(t)`
//     increments the bucket that contains t; `snapshot(now)` returns the
//     12 buckets ending at `now` (inclusive). Records outside the window
//     are silently discarded.
//   - errorCount5min is a flat array of timestamps; `count(now)` returns
//     the number still inside the 5-minute window (and opportunistically
//     trims older entries so memory stays bounded).
//   - online-user map keeps reference counts per userId (multi-tab → one
//     user, one entry in the distinct-user count).

import { describe, it, expect } from "vitest";
import {
  createMessageWindow,
  createErrorWindow,
  createOnlineUserMap,
  createSecurityEventRing,
} from "../src/lib/metrics";

describe("REQ-158 metrics · messages-per-minute window", () => {
  it("buckets records into 5-second slots, oldest first", () => {
    const win = createMessageWindow({ bucketMs: 5_000, bucketCount: 12 });
    // Fix a reference 'now' so bucket boundaries are deterministic.
    const now = 1_000_000_000_000;

    // Put 3 records in the current bucket ([now-5s, now]).
    win.record(now - 1_000);
    win.record(now - 2_000);
    win.record(now - 4_999);

    // Put 1 record in the bucket 25-30s ago.
    win.record(now - 27_000);

    // Put 2 records outside the window (> 60s ago) — must be ignored.
    win.record(now - 60_001);
    win.record(now - 10 * 60_000);

    const snap = win.snapshot(now);
    expect(snap.buckets).toHaveLength(12);
    expect(snap.buckets[11]).toBe(3);        // newest
    // 25-30s ago from the newest bucket = 5 buckets back → index 11-5 = 6
    expect(snap.buckets[6]).toBe(1);
    // every other bucket empty
    const sum = snap.buckets.reduce((a, b) => a + b, 0);
    expect(sum).toBe(4);
    expect(snap.total).toBe(4);
  });

  it("returns 12 zero buckets when nothing recorded", () => {
    const win = createMessageWindow({ bucketMs: 5_000, bucketCount: 12 });
    const snap = win.snapshot(Date.now());
    expect(snap.buckets).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(snap.total).toBe(0);
  });

  it("expires buckets as time moves forward", () => {
    const win = createMessageWindow({ bucketMs: 5_000, bucketCount: 12 });
    const t0 = 1_000_000_000_000;
    win.record(t0);
    // Immediately: newest bucket has 1
    expect(win.snapshot(t0).total).toBe(1);
    // 61s later: outside window
    expect(win.snapshot(t0 + 61_000).total).toBe(0);
  });
});

describe("REQ-158 metrics · 5xx error ring", () => {
  it("counts entries inside the 5-minute window, trims older on read", () => {
    const ring = createErrorWindow({ windowMs: 5 * 60_000 });
    const now = 1_000_000_000_000;
    ring.record(now - 10 * 60_000);  // 10m ago — drop
    ring.record(now - 4 * 60_000);   // 4m ago  — keep
    ring.record(now - 30_000);       // 30s ago — keep
    ring.record(now);

    expect(ring.count(now)).toBe(3);
    // Push forward 5m — only the most recent survives
    expect(ring.count(now + 5 * 60_000)).toBe(1);
  });
});

describe("REQ-158 metrics · online-user map", () => {
  it("distinct users — multi-tab is one user", () => {
    const map = createOnlineUserMap();
    map.connect("alice");
    map.connect("alice");    // second tab
    map.connect("bob");
    expect(map.size()).toBe(2);

    map.disconnect("alice"); // closes one tab
    expect(map.size()).toBe(2); // alice still has a tab

    map.disconnect("alice"); // closes second tab
    expect(map.size()).toBe(1);

    map.disconnect("bob");
    expect(map.size()).toBe(0);
  });

  it("disconnect below zero is a no-op (never goes negative)", () => {
    const map = createOnlineUserMap();
    map.disconnect("ghost");
    expect(map.size()).toBe(0);
  });
});

describe("REQ-158 metrics · security-event ring", () => {
  it("keeps up to the cap, newest first", () => {
    const ring = createSecurityEventRing({ cap: 3 });
    ring.push({ at: "t1", type: "csrf_fail" });
    ring.push({ at: "t2", type: "rate_limited" });
    ring.push({ at: "t3", type: "login_failed" });
    ring.push({ at: "t4", type: "csrf_fail" });

    const items = ring.items();
    expect(items).toHaveLength(3);
    // newest first
    expect(items[0].at).toBe("t4");
    expect(items[2].at).toBe("t2");
  });

  it("empty by default", () => {
    const ring = createSecurityEventRing({ cap: 50 });
    expect(ring.items()).toEqual([]);
  });
});
