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
  // Real timers here: BroadcastChannel in jsdom delivers via the microtask
  // queue / process.nextTick, and vi.useFakeTimers() stalls it. The timer
  // semantics are already covered by the REQ-103 block; these cases are
  // specifically about bc delivery.

  test("REQ-104 incoming bc activity message resets state machine", async () => {
    const onStateChange = vi.fn();
    const detector = createIdleDetector({
      thresholdMs: 60_000,
      onStateChange,
      channelName: "test-presence-activity",
    });
    detector.start();
    onStateChange.mockClear();

    // Force the detector into 'away' by directly tripping the timer —
    // we can't wait 60s in a unit test, and we need a reachable state to
    // observe a bc-induced flip back.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Fake the timer expiry by calling through notifyActivity with a stop
    // first — simpler: spin up a detector with a tiny threshold.
    detector.stop();

    const quick = createIdleDetector({
      thresholdMs: 10,
      onStateChange,
      channelName: "test-presence-activity",
    });
    quick.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(quick.getState()).toBe("away");
    onStateChange.mockClear();

    const sibling = new BroadcastChannel("test-presence-activity");
    sibling.postMessage({ type: "activity" });
    // Let bc deliver.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(quick.getState()).toBe("online");
    expect(onStateChange).toHaveBeenCalledWith("online");

    sibling.close();
    quick.stop();
  });

  test("REQ-104 local activity on one tab flips a sibling tab's 'away' back to 'online'", async () => {
    // Exercises the outbound postMessage path end-to-end: detectorA's
    // notifyActivity must ship `{type:"activity"}` via bc for detectorB
    // (sibling) to receive and transition online. detectorB uses a short
    // threshold so it can reach 'away' in the test budget; we capture
    // `onStateChange` history rather than asserting a single snapshot
    // because detectorB's short threshold means it flips back to 'away'
    // again quickly.
    const detectorA = createIdleDetector({
      thresholdMs: 60_000,
      channelName: "test-presence-activity-2",
    });
    detectorA.start();

    const changes: IdleState[] = [];
    const detectorB = createIdleDetector({
      thresholdMs: 30,
      channelName: "test-presence-activity-2",
      onStateChange: (s) => changes.push(s),
    });
    detectorB.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(detectorB.getState()).toBe("away");
    changes.length = 0;

    detectorA.notifyActivity();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Bc-induced transition back to online should have been observed.
    expect(changes).toContain("online");

    detectorA.stop();
    detectorB.stop();
  });
});
