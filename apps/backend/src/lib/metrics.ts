// REQ-158 — in-memory metrics surface for the /admin dashboard.
//
// Design contract (see .human/S3_ADMIN_AGENT_BRIEF.md §3):
//   - No Redis. Single-process assumption is acceptable for a hackathon
//     demo; horizontal scale is a follow-up.
//   - All writers are fire-and-forget, O(1) work on the request/emit path.
//     Trimming happens lazily inside snapshot() so we never need a timer.
//   - Time is injected into every primitive so unit tests are deterministic.
//   - `recordSecurityEvent({ type, ip, route })` is the s3-hardening agent's
//     import target. The signature is locked — do not rename or reshape
//     without also updating the hardening agent's preHandlers.

import { createHash } from "node:crypto";
import type {
  AdminMetricsSnapshot,
  AdminSecurityEvent,
  AdminSecurityEventType,
} from "@ai-herders/shared/protocol";
import { env } from "../env";

// ──────────────────────────────────────────────────────────────────────────
// Primitives (exported for unit tests)
// ──────────────────────────────────────────────────────────────────────────

export interface MessageWindow {
  record(at: number): void;
  snapshot(now: number): { total: number; buckets: number[] };
  reset(): void;
}

export interface ErrorWindow {
  record(at: number): void;
  count(now: number): number;
  reset(): void;
}

export interface OnlineUserMap {
  connect(userId: string): void;
  disconnect(userId: string): void;
  size(): number;
  reset(): void;
}

export interface SecurityEventRing {
  push(event: AdminSecurityEvent): void;
  items(): AdminSecurityEvent[];
  reset(): void;
}

export function createMessageWindow({
  bucketMs,
  bucketCount,
}: {
  bucketMs: number;
  bucketCount: number;
}): MessageWindow {
  // Bucket key = floor(at / bucketMs). Map → count keeps memory bounded by
  // the number of active buckets; on every snapshot we prune keys older than
  // the window so long idle runs don't leak.
  const counts = new Map<number, number>();

  const bucketOf = (t: number): number => Math.floor(t / bucketMs);

  return {
    record(at) {
      counts.set(bucketOf(at), (counts.get(bucketOf(at)) ?? 0) + 1);
    },
    snapshot(now) {
      const newestBucket = bucketOf(now);
      const oldestBucket = newestBucket - bucketCount + 1;

      for (const key of counts.keys()) {
        if (key < oldestBucket || key > newestBucket) counts.delete(key);
      }

      const buckets: number[] = [];
      for (let b = oldestBucket; b <= newestBucket; b++) {
        buckets.push(counts.get(b) ?? 0);
      }
      const total = buckets.reduce((a, b) => a + b, 0);
      return { total, buckets };
    },
    reset() {
      counts.clear();
    },
  };
}

export function createErrorWindow({
  windowMs,
}: {
  windowMs: number;
}): ErrorWindow {
  const events: number[] = [];

  return {
    record(at) {
      events.push(at);
    },
    count(now) {
      const cutoff = now - windowMs;
      while (events[0] !== undefined && events[0] < cutoff) events.shift();
      return events.length;
    },
    reset() {
      events.length = 0;
    },
  };
}

export function createOnlineUserMap(): OnlineUserMap {
  // userId → number of live sockets. Keeping a refcount (not a Set of socket
  // ids) lets multi-tab users count as one entry without us having to know
  // any socket identifier: connect ++, disconnect --, drop the key at 0.
  const counts = new Map<string, number>();

  return {
    connect(userId) {
      counts.set(userId, (counts.get(userId) ?? 0) + 1);
    },
    disconnect(userId) {
      const n = counts.get(userId);
      if (n === undefined) return;
      if (n <= 1) counts.delete(userId);
      else counts.set(userId, n - 1);
    },
    size() {
      return counts.size;
    },
    reset() {
      counts.clear();
    },
  };
}

export function createSecurityEventRing({
  cap,
}: {
  cap: number;
}): SecurityEventRing {
  const ring: AdminSecurityEvent[] = [];

  return {
    push(event) {
      ring.unshift(event);
      if (ring.length > cap) ring.length = cap;
    },
    items() {
      return ring.slice();
    },
    reset() {
      ring.length = 0;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Process-wide singletons wired to the live Fastify/Socket.IO instance
// ──────────────────────────────────────────────────────────────────────────

const messageWindow = createMessageWindow({ bucketMs: 5_000, bucketCount: 12 });
const errorWindow = createErrorWindow({ windowMs: 5 * 60_000 });
const onlineUsers = createOnlineUserMap();
const securityEvents = createSecurityEventRing({ cap: 50 });

export function recordMessageSent(now: number = Date.now()): void {
  messageWindow.record(now);
}

export function recordHttpError(
  statusCode: number,
  now: number = Date.now(),
): void {
  if (statusCode >= 500) errorWindow.record(now);
}

export function recordUserConnect(userId: string): void {
  onlineUsers.connect(userId);
}

export function recordUserDisconnect(userId: string): void {
  onlineUsers.disconnect(userId);
}

// Brief §3 pre-resolved: SHA-256(ip + SESSION_SECRET).slice(0,8). Raw IP
// never stored in memory or logs. 8 hex chars ≈ 4 bytes = enough entropy
// to deduplicate the same attacker while being opaque to a screenshot.
function redactIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return createHash("sha256")
    .update(`${ip}${env.SESSION_SECRET}`)
    .digest("hex")
    .slice(0, 8);
}

/**
 * REQ-158 — record a security event for the admin dashboard feed.
 *
 * Locked signature: the s3-hardening agent imports this from its CSRF
 * preHandler, rate-limit errorResponseBuilder, and failed-login paths.
 * Do not rename or add required params without coordinating across both
 * branches.
 */
export function recordSecurityEvent(params: {
  type: AdminSecurityEventType;
  ip?: string;
  route?: string;
}): void {
  securityEvents.push({
    at: new Date().toISOString(),
    type: params.type,
    ip: redactIp(params.ip),
    route: params.route,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Snapshot for GET /api/v1/admin/metrics
// ──────────────────────────────────────────────────────────────────────────

export function snapshotMetrics(
  now: number = Date.now(),
): AdminMetricsSnapshot {
  const msg = messageWindow.snapshot(now);
  return {
    generatedAt: new Date(now).toISOString(),
    onlineUsers: onlineUsers.size(),
    messagesPerMinute: msg.total,
    messagesPerMinuteSeries: msg.buckets,
    errorCount5min: errorWindow.count(now),
    recentSecurityEvents: securityEvents.items(),
  };
}

/**
 * Drain every singleton — test-only. Vitest runs backend tests in a single
 * fork, so these module-scope counters persist across files. Any test that
 * asserts absolute counts must call this in `beforeEach`.
 */
export function __resetMetricsForTests(): void {
  messageWindow.reset();
  errorWindow.reset();
  onlineUsers.reset();
  securityEvents.reset();
}
