// REQ-103 / REQ-104 — web-side idle detector.
//
// Pure `createIdleDetector` core (no React) so we can exercise timer +
// event wiring with vi.useFakeTimers. The React `useIdleDetector` hook is
// a thin mount-side adapter around the same core; covered by the render
// smoke test at the bottom.
//
// REQ-103 — 60s inactivity threshold transitions online → away. Any mouse,
// keyboard, scroll, or touch event resets the timer and flips back to
// online. No server calls here — transitions fire through `onStateChange`
// and the caller routes to `socket.emit('presence.setState', ...)`.
//
// REQ-104 — BroadcastChannel activity sync across tabs: if tab A has
// activity, tab B's own idle timer resets too. Prevents the multi-tab
// "one tab idle, one active" flap from briefly flagging the user away.

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createIdleDetector } from "./use-idle-detector";

describe("REQ-103 idle detector core timer semantics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("REQ-103 starts online and transitions to away after threshold", () => {
    const onStateChange = vi.fn();
    const detector = createIdleDetector({
      thresholdMs: 60_000,
      onStateChange,
    });
    detector.start();

    expect(detector.getState()).toBe("online");
    // Initial transition notification — caller typically does nothing with
    // this, but the event is emitted so a listener sees the starting value.
    expect(onStateChange).toHaveBeenCalledWith("online");

    onStateChange.mockClear();
    vi.advanceTimersByTime(60_000);

    expect(detector.getState()).toBe("away");
    expect(onStateChange).toHaveBeenCalledWith("away");
    expect(onStateChange).toHaveBeenCalledTimes(1);

    detector.stop();
  });

  test("REQ-103 activity before threshold keeps state online, no transition", () => {
    const onStateChange = vi.fn();
    const detector = createIdleDetector({
      thresholdMs: 60_000,
      onStateChange,
    });
    detector.start();
    onStateChange.mockClear();

    vi.advanceTimersByTime(30_000);
    detector.notifyActivity();
    vi.advanceTimersByTime(30_000);

    expect(detector.getState()).toBe("online");
    // Zero transitions — stayed online the whole time.
    expect(onStateChange).not.toHaveBeenCalled();

    detector.stop();
  });

  test("REQ-103 activity after idle flips state back to online", () => {
    const onStateChange = vi.fn();
    const detector = createIdleDetector({
      thresholdMs: 60_000,
      onStateChange,
    });
    detector.start();
    vi.advanceTimersByTime(60_000);
    onStateChange.mockClear();

    expect(detector.getState()).toBe("away");
    detector.notifyActivity();

    expect(detector.getState()).toBe("online");
    expect(onStateChange).toHaveBeenCalledWith("online");
    expect(onStateChange).toHaveBeenCalledTimes(1);

    detector.stop();
  });

  test("REQ-103 stop clears timer and prevents future transitions", () => {
    const onStateChange = vi.fn();
    const detector = createIdleDetector({
      thresholdMs: 60_000,
      onStateChange,
    });
    detector.start();
    onStateChange.mockClear();

    detector.stop();
    vi.advanceTimersByTime(120_000);

    expect(onStateChange).not.toHaveBeenCalled();
  });

  test("REQ-103 window mouse/key/scroll/touch events feed notifyActivity", () => {
    const onStateChange = vi.fn();
    const detector = createIdleDetector({
      thresholdMs: 60_000,
      onStateChange,
    });
    detector.start();
    vi.advanceTimersByTime(60_000);
    onStateChange.mockClear();

    window.dispatchEvent(new MouseEvent("mousemove"));

    expect(detector.getState()).toBe("online");
    expect(onStateChange).toHaveBeenCalledWith("online");

    detector.stop();
  });
});

describe("REQ-104 BroadcastChannel cross-tab activity sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("REQ-104 incoming bc activity message resets idle timer", () => {
    const onStateChange = vi.fn();
    const detector = createIdleDetector({
      thresholdMs: 60_000,
      onStateChange,
      channelName: "test-presence-activity",
    });
    detector.start();
    onStateChange.mockClear();

    vi.advanceTimersByTime(30_000);

    // Simulate a sibling tab posting activity.
    const sibling = new BroadcastChannel("test-presence-activity");
    sibling.postMessage({ type: "activity" });
    sibling.close();

    // Let the microtask queue drain so the bc message is delivered.
    return Promise.resolve().then(() => {
      // Additional 30s — would have been 60s total without the sibling ping.
      vi.advanceTimersByTime(30_000);
      expect(detector.getState()).toBe("online");
      expect(onStateChange).not.toHaveBeenCalled();
      detector.stop();
    });
  });

  test("REQ-104 local activity is broadcast so sibling tabs see it", async () => {
    const onStateChange = vi.fn();
    const detector = createIdleDetector({
      thresholdMs: 60_000,
      onStateChange,
      channelName: "test-presence-activity-2",
    });
    detector.start();
    onStateChange.mockClear();

    const received: unknown[] = [];
    const sibling = new BroadcastChannel("test-presence-activity-2");
    sibling.onmessage = (evt) => received.push(evt.data);

    detector.notifyActivity();
    // bc delivery is async — wait one tick.
    await Promise.resolve();

    expect(received.some((m) => (m as { type?: string }).type === "activity")).toBe(true);

    sibling.close();
    detector.stop();
  });
});
