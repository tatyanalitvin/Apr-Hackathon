# Spec: S3 — Attachment GC + Room Moderation Rate Limit

**Status**: draft
**Branch**: `feat/s3-gc-and-moderation-rl` (new worktree off `main`; no remote per hackathon policy)
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code

Three follow-ups promoted from [docs/FOLLOWUPS.md](../FOLLOWUPS.md) into a single spec because they share the same long-running-task plumbing (the moderation RL reuses the Redis client pattern from existing limiters; the account-delete cleanup rides on the same GC job as the orphan sweep).

## 1. Why

Three S3 follow-ups whose risk was bounded at 300-user / 24h hackathon scale but which the human flagged for pre-submission hardening:

- **Moderation RL**: today any admin with a live cookie can burst-fire `POST /rooms/:id/bans` or `POST /rooms/:id/admins/:userId` at line-rate. The comment at [rooms.ts:693](../../apps/backend/src/routes/rooms.ts#L693) explicitly acknowledges "moderation RL is punted to S3".
- **Orphan attachment GC**: the 2-step upload flow (REQ-075 step 1 orphan row, step 2 link to message) leaves rows + bytes behind when step 2 never fires (client crash, rejected send, abandoned tab). Tracked as `TODO(S3-GC)` at [schema.ts:370-371](../../packages/shared/src/schema.ts#L370-L371).
- **Tombstoned-user attachment retention**: soft-deleted users keep their `user` row (so `message.authorId` FKs hold), and `attachment.uploaderId` has `onDelete: cascade` to `user.id` — so bytes authored by a tombstoned user stay on disk indefinitely. [s2-account-gdpr.md:17](./s2-account-gdpr.md#L17) punts this to "S3 orphan-GC job will extend to sweep messages authored by deleted users".

## 2. Non-goals

- **Distributed GC coordination.** Single-instance `setInterval` is sufficient for the hackathon. Multi-instance would need a Redis lock; deferred.
- **Tunable retention via admin UI.** Window is a module-level const. S3-admin owns config surfaces, not this spec.
- **Signed-URL replacement for the download handler** (REQ-151) — unrelated S3 item, out of scope.
- **Per-endpoint RL overrides.** All five moderation endpoints share one dual-tier bucket. Burst of 10/60s + sustained 60/3600s is good enough for all of them.
- **Back-pressure on in-flight GC.** If GC overruns its interval, we skip the next tick via a simple "running" flag; no queue.

## 3. User stories

- As a room admin, if I click the ban button 15 times in 30 seconds (bug, impatient user, or malicious), the 11th-15th get `429 rate_limited` instead of actually performing 15 DB writes + 15 socket emits.
- As the demo operator, after I run `docker compose up` and leave it for 15 minutes, orphaned attachments from aborted uploads disappear from `UPLOAD_DIR` and from the DB. No cron, no manual step.
- As a user who deleted my account an hour ago, my old uploads in rooms I still-had-access-to are gone from the server (bytes + DB row). My authored messages remain visible per REQ-018, but attachments in them render as "file unavailable" chips on the client side.
- As a backend engineer, I can read the GC module once and know exactly what it does, in what order, with what retention windows, and what gets logged when.

## 4. Requirements (testable)

- [ ] **R1** — `lib/room-moderation-rate-limit.ts` exports `checkModerationRateLimit(userId, roomId): Promise<{allowed, retryAfterSec}>`. Dual-tier: 10 calls / 60s burst + 60 calls / 3600s sustained, enforced via two Redis keys keyed `rate:mod:burst:${userId}:${roomId}` and `rate:mod:sustained:${userId}:${roomId}`. When either tier overflows, `allowed=false` and `retryAfterSec` = the LARGER of the two tier TTLs (so retry truly clears).
  - **INCR-order discipline**: INCR burst first. If burst overflowed, do NOT INCR sustained — use `GET` to read its current value instead. If burst is OK, INCR sustained; if sustained overflows, DECR burst (best-effort; ignore failure) so a rejected call doesn't also burn the burst tier. Rationale: without this, a caller who hits 10 bursts in the first 2s keeps spamming during the 60s block and over a minute fills the sustained cap purely with rejected calls — converting a 1-min block into a 1-hour jail.
  - **Redis-outage policy**: on any error from `getClient()`/INCR/GET, catch + log WARN + return `{allowed: true, retryAfterSec: 0}` (fail open). Mirrors `@fastify/rate-limit`'s `skipOnError: true` ([app.ts:123](../../apps/backend/src/app.ts#L123)). Full Redis outage must not brick moderation.
- [ ] **R2** — Each of the five moderation endpoints in [rooms.ts](../../apps/backend/src/routes/rooms.ts) calls `checkModerationRateLimit(ctx.userId, roomId)` AFTER `requireFriendshipAuth` and BEFORE any DB read. On `allowed=false`, return `429 { error:"rate_limited", retryAfterSec }` AND log WARN with `{userId, roomId, endpoint}` for ops visibility (Q1 resolved). The `retryAfterSec` field name (not `retryAfter`) deliberately matches the existing hand-rolled limiters at [mutes.ts:70](../../apps/backend/src/routes/mutes.ts#L70) and [friend-rate-limit.ts](../../apps/backend/src/lib/friend-rate-limit.ts); the global `@fastify/rate-limit` plugin at [app.ts:170](../../apps/backend/src/app.ts#L170) uses `retryAfter` (plain) — we're NOT joining that shape, because the web client's hand-rolled 429 handlers already decode `retryAfterSec` for all the per-user limiters. Endpoints:
  - `POST /api/v1/rooms/:id/admins/:userId` (promote) — REQ-201, [rooms.ts:697](../../apps/backend/src/routes/rooms.ts#L697)
  - `DELETE /api/v1/rooms/:id/admins/:userId` (demote) — REQ-202, [rooms.ts:765](../../apps/backend/src/routes/rooms.ts#L765)
  - `DELETE /api/v1/rooms/:id/members/:userId` (kick) — REQ-203, [rooms.ts:841](../../apps/backend/src/routes/rooms.ts#L841)
  - `POST /api/v1/rooms/:id/bans` (ban) — REQ-204, [rooms.ts:943](../../apps/backend/src/routes/rooms.ts#L943)
  - `DELETE /api/v1/rooms/:id/bans/:userId` (unban) — REQ-205, [rooms.ts:1065](../../apps/backend/src/routes/rooms.ts#L1065)
- [ ] **R3** — The "moderation RL is punted to S3" comment at [rooms.ts:693](../../apps/backend/src/routes/rooms.ts#L693) is rewritten to describe the actual shared-helper call site (or deleted if redundant with a comment on the helper call).
- [ ] **R4** — `lib/attachment-gc.ts` exports `runAttachmentGc(db): Promise<{orphansDeleted, tombstonedDeleted, unlinkFailures, skipped}>`. Two-pass:
  1. **Orphan pass**: `SELECT id, storagePath FROM attachment WHERE messageId IS NULL AND createdAt < now() - INTERVAL '1 hour'`. For each row: `fs.unlink(resolveStorageAbsolute(storagePath))` (ENOENT logged + ignored; other errors logged + row retained for next tick). Then `DELETE FROM attachment WHERE id = ANY($ids) AND messageId IS NULL` for successfully-unlinked ids — the redundant `messageId IS NULL` predicate guards against the race where a very slow in-flight message-send UPDATE'd the row between our SELECT and DELETE; better to leave the attachment for next tick than to 404 a just-linked message.
  2. **Tombstoned-user pass**: `SELECT a.id, a.storagePath FROM attachment a JOIN "user" u ON u.id = a.uploader_id WHERE u.deleted_at IS NOT NULL AND u.deleted_at < now() - INTERVAL '1 hour'`. Same unlink + delete. The DB row stays until our sweep because `attachment.uploaderId` has `onDelete: cascade` to `user.id` but the user row itself is soft-deleted (preserved to keep `message.authorId` FKs alive per REQ-018) — so the cascade never fires. A message authored by a tombstoned user that had multiple attachments from multiple uploaders only loses the one uploaded by the tombstoned user; other uploaders' attachments on the same message are untouched (scoped by `uploaderId`, not `messageId`).
- [ ] **R5** — `lib/attachment-gc.ts` exports `startAttachmentGc(app)` that registers a `setInterval` at 15 min, runs once on boot, and installs an `onClose` hook to `clearInterval`. A module-level `running` flag makes `runAttachmentGc` return `{skipped: true}` and short-circuit if the previous tick hasn't finished (no queue buildup on slow disks).
- [ ] **R6** — `startAttachmentGc` is called from `buildApp()` in [app.ts](../../apps/backend/src/app.ts) AFTER route registration and BEFORE `createSocketIO` — order matters for `onClose` teardown: hooks fire in registration order, so the GC interval cleanup must be registered ahead of the socket teardown to avoid a log-error if a GC tick mid-flight references `app` after socket close.
- [ ] **R7** — GC logs per tick at INFO level: `{ orphansDeleted, tombstonedDeleted, unlinkFailures, durationMs, skipped }`. One log level only — 96 idle lines/day at 15min interval is not noise worth branching around.
- [ ] **R8** — GC never throws out of its interval callback. Any rejection is caught and logged at WARN. The interval survives a full GC failure and retries on the next tick.
- [ ] **R9** — `checkModerationRateLimit` uses its own Redis connection (same pattern as friend-rate-limit.ts: `createClient` from `redis` package, lazy `getClient`, `closeModerationRateLimit` for test teardown). NOT better-auth's secondary-storage; NOT the ioredis client used by `@fastify/rate-limit`.
- [ ] **R10** — All new tests use ONE `buildApp()` per Vitest file (memory `feedback-vitest-one-buildapp`). GC tests drive `runAttachmentGc` directly; they do NOT rely on the `setInterval` firing. A single boot-lifecycle test asserts the interval is registered + cleared on close (via app lifecycle + a shortened interval const exported for tests).

## 5. Design notes

### Data model changes

None. Existing `attachment.messageId` nullability + `user.deletedAt` soft-delete column cover both GC passes.

### Rate-limit module (`lib/room-moderation-rate-limit.ts`)

Two Redis counters per `(userId, roomId)` pair; both INCR'd in the same check. The WHOLE check rejects if EITHER tier has overflowed. Rationale: the burst tier catches "impatient clicker / bot" (10 actions/min is already way above human moderation rate), the sustained tier catches "compromised admin running a script" (60/hr = one per minute for an hour is suspect). Keys:

```text
rate:mod:burst:<userId>:<roomId>      TTL 60s    cap 10
rate:mod:sustained:<userId>:<roomId>  TTL 3600s  cap 60
```

Retry-after = max of the two TTLs so the caller isn't told "1s" when sustained tier still blocks for 47min. Ordering inside handlers:

```ts
const ctx = await requireFriendshipAuth(request, reply);
if (!ctx) return;
const rl = await checkModerationRateLimit(ctx.userId, roomId);
if (!rl.allowed) return reply.status(429).send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
// ...existing logic
```

### GC module (`lib/attachment-gc.ts`)

One module with two exports: the pure `runAttachmentGc(db)` (unit-testable, no timers) and the `startAttachmentGc(app)` lifecycle wrapper (integration-only). Interval = 15 min via exported `ATTACHMENT_GC_INTERVAL_MS` const; tests can override via a test-only setter in the same file (mirrors `__setTestRateLimitGlobalMax` in app.ts).

```ts
// Pseudocode — see R4/R5/R6/R7/R8.
let running = false;
export async function runAttachmentGc(db): Promise<GcResult> {
  if (running) return { skipped: true };
  running = true;
  try {
    const orphans = await sweepOrphans(db);
    const tombstoned = await sweepTombstoned(db);
    return { orphansDeleted, tombstonedDeleted, unlinkFailures, skipped: false };
  } finally {
    running = false;
  }
}
```

Unlink strategy: never let a stuck file block a DB row delete. If `fs.unlink` fails with anything other than ENOENT, we keep the DB row so next tick retries — this is self-healing. The pathological "transient IO error on 100 rows" case converges in 15 min per retry.

### Hook point in `app.ts`

`startAttachmentGc(app)` is called after route registration, before the socket attach. The `onClose` hook to clear the interval is registered in the module itself (so the lifecycle is self-contained and doesn't leak responsibility into app.ts).

### Retention windows

- Orphan: 1 hour (matches FOLLOWUPS spec).
- Tombstoned: 1 hour. v4 REQ-084 targets 7 days but that never triggers in a 24h hackathon; 1h is short enough to be demonstrable during the gate + gives a small window to revert an accidental delete (password re-auth already provides defence there, so 1h is more "kindness than safety").

### Known dangling-file gap (out of scope — NOT a test target)

`attachment.roomId` has `onDelete: cascade` to `room.id` ([schema.ts:373-375](../../packages/shared/src/schema.ts#L373-L375)). When a room is deleted, its attachment rows vanish via FK cascade — but the files on disk linger because the cascade is DB-only. Neither GC pass catches these because the orphan pass uses a row condition (`messageId IS NULL`) and the tombstoned pass needs a live attachment row. A filesystem-level sweep of `UPLOAD_DIR` for dangling bytes would need to diff against the attachment table — out of scope for this spec. [s2-rooms.md REQ-087](./s2-rooms.md) owns the pre-cascade unlink; if it has a bug, dangling files accumulate but no correctness invariant breaks. Not gate-critical at 24h demo scale.

### Security / auth

- Moderation RL is orthogonal to authz (ownership check still runs inside the handler). RL comes BEFORE authz so a non-owner spamming the endpoint still hits 429, not 403 — preventing enumeration of "which rooms do I admin" via timing.
- GC runs with the same DB pool as request-handlers; no elevated privileges needed. Drizzle `db.execute` + parameterised deletes.

## 6. Tasks (in fastest-to-slowest order)

1. [ ] **Write failing test for R4 (orphan sweep)** — `lib/attachment-gc.test.ts`. Seed: 3 orphans (messageId null, one < 1h old, two > 1h old), 1 linked attachment. Run `runAttachmentGc`. Assert: 2 orphans deleted, 1 orphan + linked attachment remain, files unlinked from tmp UPLOAD_DIR. One buildApp per file.
2. [ ] **Implement R4 orphan pass** — `lib/attachment-gc.ts` with sweepOrphans + the pure `runAttachmentGc` shell. Test green.
3. [ ] **Write failing test for R4 (tombstoned pass + multi-attachment message)** — same file. Seed: 1 tombstoned user (deletedAt 2h ago) uploading attachment A on message M1; 1 fresh-tombstoned user (deletedAt 30min ago) uploading attachment B on message M2; 1 live user uploading attachment C on message M1 (co-attachment with A, same message, different uploader). Assert: only A is deleted; B and C remain; M1 still exists with C referenced.
4. [ ] **Implement R4 tombstoned pass** — add sweepTombstoned. Test green.
5. [ ] **Write failing test for `running` re-entry + Redis-outage fail-open** — `lib/attachment-gc.test.ts` (expand). Test 5a: call `runAttachmentGc` twice concurrently (no await between); second returns `{skipped:true}`, no double-delete. Test 5b: induce a thrown error from inside `sweepOrphans` (mock) and assert the tick logs + does not crash the process.
6. [ ] **Write failing test for R5/R6 lifecycle** — `lib/attachment-gc-lifecycle.test.ts`. Build the app with a test-only 50ms interval (exported setter). Seed an orphan > 1h old. `await new Promise(r => setTimeout(r, 120))`. Assert orphan gone. Close app. Assert interval cleared (no further GC ticks after close).
7. [ ] **Implement R5/R6 startAttachmentGc + app.ts wire-up** — test green.
8. [ ] **Write failing test for R1/R9 moderation RL helper** — `lib/room-moderation-rate-limit.test.ts`. Redis flush in beforeEach. Test 8a: 10 calls allowed within 60s, 11th blocked, 11th retryAfterSec ~= 60. Test 8b: 61st call in 3600s blocked even if burst tier clear (sleep / manual TTL expire to isolate). Test 8c (INCR-order): after burst blocks at call 11, call 20 more times (all 429); then wait for burst TTL; assert sustained counter has NOT been pushed past cap (the DECR / GET-instead-of-INCR discipline from R1 is honoured). Test 8d (Redis outage): stop Redis mock mid-call, assert `{allowed:true, retryAfterSec:0}` (fail open).
9. [ ] **Implement R1/R9 helper** — test green.
10. [ ] **Write failing integration test for R2** — `tests/rooms-moderation-rate-limit.test.ts`. One sub-test per endpoint (5 sub-tests) under one describe + one `buildApp`. 11th call returns 429 with expected body shape `{error:"rate_limited", retryAfterSec}`. `flushRedis()` between sub-tests to keep counters independent.
11. [ ] **Implement R2** — add the `checkModerationRateLimit` call to all five handlers in rooms.ts. Verify REQ-203 kick endpoint location (rooms.ts ~:841 per reviewer); update spec R2 line refs if off. Update R3 comment. Integration tests green.
12. [ ] **Manual batched smoke** — `docker compose --build` up, drive a moderation endpoint via curl x12 → observe 429. Upload an attachment, abort before send, call a `runAttachmentGc`-triggering endpoint (or wait — see §8 Q2: curl-only, no env toggle). Observe the file gone + DB row gone. Per memory `feedback-batched-smoke`, this is ONE smoke checkpoint at the end, not per-task.
13. [ ] **Strike the three FOLLOWUPS entries** — mark as shipped on `feat/s3-gc-and-moderation-rl` with a `~~...~~` strike + shipped date in [docs/FOLLOWUPS.md](../FOLLOWUPS.md).

## 7. Out of scope / follow-ups

- **Multi-instance GC lock** — when we scale beyond one backend container, add a `SET NX EX` advisory lock around `runAttachmentGc`. Not needed for the 24h demo.
- **Admin dashboard GC stats** — S3-admin could surface `{orphansDeleted, tombstonedDeleted}` per tick. Folds into metrics.ts if anyone wants it.
- **Tunable retention via env** — today the windows are const; a future refactor can make them `env.ATTACHMENT_ORPHAN_RETENTION_SECONDS` etc. No env change this spec.
- **Cascade "file unavailable" UX** — the web client already handles 404 on the download endpoint gracefully (shows the chip but disables the button). No frontend change required here.

## 8. Resolved decisions

- **Q1 (resolved, yes)**: Moderation RL 429 logs a WARN with `{userId, roomId, endpoint}` for ops visibility — consistent with the global rate-limit handler and cheap.
- **Q2 (resolved, curl-only)**: Smoke test drives via curl. No test-only env for shortening the GC interval in the running container — the Vitest lifecycle test already proves the interval fires; the smoke just needs to confirm the limiter wiring.
