// REQ-103 / REQ-104 — web-side idle detector.
//
// The pure `createIdleDetector` owns a setTimeout-driven online↔away state
// machine and wires window activity events into it. `useIdleDetector` is
// the thin React adapter that ties its lifecycle to a component mount.
//
// BroadcastChannel (REQ-104) is used for cross-tab activity sync — any
// tab's activity is broadcast on `channelName`, and siblings reset their
// own idle timers on receipt. This prevents the "two tabs open, one idle"
// flap where a user sitting in tab A would get flagged away because tab B
// (in the background) hadn't seen any input. BroadcastChannel may be
// unavailable (SSR, old test envs) — guard with typeof and no-op.

import { useEffect, useRef, useState } from "react";

export type IdleState = "online" | "away";

const DEFAULT_THRESHOLD_MS = 60_000;
const DEFAULT_CHANNEL = "ai-herders.presence.activity";
// The events we watch for activity. Pointer-style inputs + scroll cover the
// demo path (mouse move = online; scroll-only users covered too).
const ACTIVITY_EVENTS = ["mousemove", "keydown", "scroll", "touchstart"] as const;

export interface IdleDetectorOptions {
  thresholdMs?: number;
  onStateChange?: (state: IdleState) => void;
  channelName?: string;
}

export interface IdleDetector {
  start(): void;
  stop(): void;
  notifyActivity(): void;
  getState(): IdleState;
}

export function createIdleDetector(options: IdleDetectorOptions = {}): IdleDetector {
  const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const channelName = options.channelName ?? DEFAULT_CHANNEL;
  const onStateChange = options.onStateChange;

  let state: IdleState = "online";
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let bc: BroadcastChannel | undefined;
  let started = false;

  const transition = (next: IdleState): void => {
    if (state === next) return;
    state = next;
    onStateChange?.(state);
  };

  const scheduleIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      transition("away");
    }, thresholdMs);
  };

  const resetTimerAndEnsureOnline = (): void => {
    if (!started) return;
    if (state !== "online") transition("online");
    scheduleIdle();
  };

  // Public `notifyActivity` (and window events) broadcast out so sibling
  // tabs see the activity. Incoming bc messages skip the broadcast to
  // avoid a rebroadcast loop.
  const notifyActivity = (): void => {
    resetTimerAndEnsureOnline();
    if (bc) {
      try {
        bc.postMessage({ type: "activity" });
      } catch {
        // Channel may have been closed between tick boundaries.
      }
    }
  };

  const onRemoteActivity = (evt: MessageEvent): void => {
    const data = evt.data as { type?: string } | null;
    if (data?.type !== "activity") return;
    resetTimerAndEnsureOnline();
  };

  return {
    start() {
      if (started) return;
      started = true;
      state = "online";
      onStateChange?.("online");
      scheduleIdle();

      if (typeof window !== "undefined") {
        for (const name of ACTIVITY_EVENTS) {
          window.addEventListener(name, notifyActivity, { passive: true });
        }
      }

      if (typeof BroadcastChannel !== "undefined") {
        bc = new BroadcastChannel(channelName);
        bc.onmessage = onRemoteActivity;
      }
    },

    stop() {
      if (!started) return;
      started = false;
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      if (typeof window !== "undefined") {
        for (const name of ACTIVITY_EVENTS) {
          window.removeEventListener(name, notifyActivity);
        }
      }
      if (bc) {
        bc.onmessage = null;
        bc.close();
        bc = undefined;
      }
    },

    notifyActivity,

    getState() {
      return state;
    },
  };
}

export interface UseIdleDetectorOptions {
  thresholdMs?: number;
  channelName?: string;
}

/**
 * React mount-time wrapper around createIdleDetector. Returns the live
 * state and calls onStateChange on every transition. Caller typically
 * forwards onStateChange into `socket.emit('presence.setState', ...)`.
 */
export function useIdleDetector(
  onStateChange: (state: IdleState) => void,
  options: UseIdleDetectorOptions = {},
): IdleState {
  const [state, setState] = useState<IdleState>("online");
  // Keep the latest callback without reattaching the detector each render.
  const callbackRef = useRef(onStateChange);
  useEffect(() => {
    callbackRef.current = onStateChange;
  }, [onStateChange]);

  useEffect(() => {
    const detector = createIdleDetector({
      thresholdMs: options.thresholdMs,
      channelName: options.channelName,
      onStateChange: (next) => {
        setState(next);
        callbackRef.current(next);
      },
    });
    detector.start();
    return () => {
      detector.stop();
    };
  }, [options.thresholdMs, options.channelName]);

  return state;
}
