# Spec: S2 — Friendship (requests + contacts + user-to-user block)

**Status**: draft (2026-04-18)
**Branch**: `feat/s2-friendship` (worktree to be created off `main` after S1 merges)
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code — S2 relationships agent
**Scope**: REQ-050 … REQ-060 (friends list, send/accept/decline/remove request, contacts) + REQ-073, REQ-074 (user-to-user block, unblock). DMs (REQ-061 … REQ-066) depend on this spec and land in `s2-dms.md` — do NOT touch DM plumbing here.

## 1. Why

Friendship is the gate for DMs (REQ-060). No friendship → no DM → BRIEF.md demo step 3–4 ("Alice adds bob as friend; they open a DM") cannot run. Block is the inverse gate: banning a user must tear down the friendship AND freeze any open DM (REQ-073 effects 1–2), and this spec owns the first half of that (the friendship/block tables); `s2-dms.md` owns the freeze check on the send path.

Every row in `friendship`, `friend_request`, `user_block` is already in `packages/shared/src/schema.ts` as of S1 (see §5 data model). This spec is wiring — REST endpoints, rate limits, sentinel-success semantics, and one Socket.IO event. No schema changes expected; deltas are flagged in §5 and §8.

## 2. Non-goals

Explicit, so reviewers don't flag:

- **DM entity, DM send path, DM freeze enforcement** — `s2-dms.md` (REQ-061 … REQ-066). This spec owns the *data* that DM freeze reads (friendship row + user_block row); it does NOT own the send-time freeze check.
- **Attachments on friend-request notes** — REQ-051 says note is text ≤500 bytes UTF-8; no file attachment.
- **Friend-request-from-member-panel UI** — REQ-052 is a UI affordance on top of REQ-051's API. This spec ships the API; UI lands in the S2 web spec.
- **Nightly TTL sweep of expired pending requests** — REQ-056 (30-day TTL) explicitly defers the sweep to REQ-163 (S3 scheduler). This spec writes rows that *eventually* get swept; the cron lives in S3.
- **Report abuse / moderation** — REQ-065, REQ-156, REQ-157 are separate moderation work.
- **Presence-under-ban behavior** — REQ-105 ("B appears offline to A") is in the S2 presence/AFK spec, not here. This spec stores the `user_block` row that REQ-105 reads; it does not modify any presence broadcast.
- **Username rectification** — REQ-127 is deferred per BRIEF.md "Out of scope".
- **Dialog unfreeze propagation** — REQ-066 auto-unfreeze on (unblock ∧ re-friend) is a read-time predicate in `s2-dms.md`; this spec just guarantees the underlying rows reflect current truth.

## 3. User stories

- As Alice, I `POST /api/v1/friends/requests` with `{ toUsername: "bob" }` and bob gets a pending request visible in his contacts tab. (REQ-051)
- As Alice, if bob has blocked me, the API still returns `200 { status: "sent" }` but no row is created — I can't tell I'm blocked. (REQ-053)
- As Alice, I can't spam bob: after 20 outgoing requests in 24h the 21st returns `429`. (REQ-054)
- As Alice, re-sending a pending request to bob updates the `message` in place instead of creating a duplicate row. (REQ-055)
- As Bob, I `GET /api/v1/friends/requests?direction=incoming` and see Alice's pending request; I respond with `POST .../requests/:id/accept|decline|block`. (REQ-057)
- As Alice, when bob accepts, my client receives `friend.request.accepted` over Socket.IO. Decline and Block are silent. (REQ-058)
- As Alice or Bob, either of us can `DELETE /api/v1/friends/:userId` to unfriend; the `friendship` row is deleted, neither side gets a notification, no ban is created. (REQ-059)
- As Alice, `GET /api/v1/friends` returns my accepted friends list (bob, carol). (REQ-050)
- As Alice, I can `POST /api/v1/users/:id/block` to block bob — this deletes the friendship row (if any), deletes any pending request between us, and the `user_block` row now exists. (REQ-073 effects 1, 3, 4)
- As Alice, `DELETE /api/v1/users/:id/ban` removes the block row; friendship is NOT auto-restored. (REQ-074)

## 4. Requirements (testable)

`pnpm trace` greps `tests/` for each REQ-ID. Test `describe` / `test` names MUST embed them verbatim.

- [ ] **R1 (REQ-050)**: `GET /api/v1/friends` returns `{ friends: Array<{ userId, username, name, friendedAt }> }` for the authenticated user — one entry per row in `friendship` where the caller is `userAId` OR `userBId`. Ordered by `friendedAt` DESC. 401 without session.
- [ ] **R2 (REQ-051)**: `POST /api/v1/friends/requests` with `sendFriendRequestSchema` (already in `dto.ts`: `{ toUsername, message? }`) — resolves `toUsername` → `user.id`, inserts `friend_request` row with `fromId=caller`, `toId=target`, `message`, `status='pending'`. 201 with `{ id, status: 'pending' }`. 404 if username unknown. 400 if self (`fromId === toId`). **Deviation flag**: v4 REQ-051 accepts `targetUsername | targetUserId`; our DTO currently only has `toUsername`. Adding `toUserId` is trivial but is a dto change — see §8 Q1.
- [ ] **R3 (REQ-052)**: No backend change — REQ-052 is a UI requirement that calls REQ-051's endpoint with the target's resolved userId. Left as-is; R2 covers the API.
- [ ] **R4 (REQ-053)**: If `user_block` has a row with `byId=target, targetId=caller` (i.e. target has blocked caller), the endpoint returns `201 { id: null, status: 'sent' }` and inserts NO `friend_request` row. Test asserts: (a) HTTP 201, (b) response shape matches the sentinel, (c) zero rows in `friend_request` for the `(fromId, toId)` pair. Rationale: leaking the block would let a blocker be enumerated.
- [ ] **R5 (REQ-054)**: Rate limit: 20 outgoing friend requests per `fromId` per rolling 24h window. 21st request → 429 with `{ error: "rate_limited", retryAfterSec }`. Implement via `@fastify/rate-limit` keyed by `userId` (already a pinned dep per CLAUDE.md tech stack). Bucket counts the INSERT attempts including sentinel-success paths (R4) to prevent enumeration by rate-limit-burn.
- [ ] **R6 (REQ-055)**: Duplicate request semantics. If an existing `friend_request` row exists with `(fromId=caller, toId=target, status='pending')`, the endpoint UPDATEs `message` + `createdAt` (=now) on that row instead of inserting. Returns 200 (not 201) with the same row id. Enforced by the existing unique index `friend_request_from_to_uq` on `(fromId, toId)` — catch the unique violation and do an UPDATE. **Wrinkle**: the unique index is on `(fromId, toId)` without a status predicate, so a previously-accepted or rejected row would also collide. On collision: if `status='pending'` → UPDATE (REQ-055 path); if `status='accepted'` → 409 `already_friends`; if `status='rejected'` → UPDATE status back to `pending` + refresh `message` + clear `respondedAt` (treat as a fresh attempt). Tests cover all three branches.
- [ ] **R7 (REQ-056)**: Pending request TTL. Rows with `status='pending' AND createdAt < now() - 30d` are considered expired. The nightly sweep is S3 (REQ-163) — NOT in this spec's code. This spec's R7 is a **read-side filter**: `GET /api/v1/friends/requests` MUST exclude rows older than 30 days even if `status='pending'` (since the sweep hasn't happened yet). Test: insert a row with backdated `createdAt=now()-31d, status='pending'`, assert it is absent from both `direction=incoming` and `direction=outgoing` responses. **Data model gap flagged**: `friend_request` has no `deletedAt`/`expiredAt` column. REQ-056 says the sweep soft-deletes; options in §8 Q2.
- [ ] **R8 (REQ-057 accept)**: `POST /api/v1/friends/requests/:id/accept` — caller must be `toId` on the row, status must be `pending`. In a single transaction: UPDATE `friend_request` SET `status='accepted', respondedAt=now()`; INSERT INTO `friendship (userAId, userBId)` where A/B are the two users sorted by id ASC (matches the schema's normalization convention — comment on `friendship` table: "Normalize so userAId < userBId"). ON CONFLICT on `friendship_pair_uq` → DO NOTHING (idempotent if row already exists). 200 with `{ status: 'accepted', friendshipId }`. 403 if caller ≠ `toId`. 409 if status ≠ 'pending'.
- [ ] **R9 (REQ-057 decline)**: `POST /api/v1/friends/requests/:id/decline` — caller must be `toId`. UPDATE `friend_request` SET `status='rejected', respondedAt=now()`. No friendship created, no user_block created. 200 `{ status: 'rejected' }`. No Socket.IO event (REQ-058).
- [ ] **R10 (REQ-057 block)**: `POST /api/v1/friends/requests/:id/block` — caller must be `toId`. In a single transaction: UPDATE `friend_request` SET `status='rejected', respondedAt=now()`; INSERT INTO `user_block (byId=caller, targetId=fromId)` ON CONFLICT DO NOTHING; DELETE any `friendship` row between the pair (there shouldn't be one since the request is pending, but defensive). 200 `{ status: 'blocked' }`. No Socket.IO event.
- [ ] **R11 (REQ-058)**: On R8 (accept) success only, emit `friend.request.accepted` over Socket.IO to a per-user room `user:{fromId}` with `{ type: "friend.request.accepted", requestId, friendId, friendUsername, acceptedAt }`. Decline (R9) and Block (R10) emit nothing. **Protocol gap flagged**: `protocol.ts` has no `friend.request.accepted` event or the per-user socket room convention. Additions in §8 Q3.
- [ ] **R12 (REQ-059)**: `DELETE /api/v1/friends/:userId` — caller can be either side. DELETE the single `friendship` row matching the normalized pair. 204. No Socket.IO event. The DM freeze side-effect (REQ-059 second clause "Any open DM dialog MUST be frozen") is *observed* by `s2-dms.md` reading the absence of friendship at send time — this spec just owns the DELETE. Idempotent: 204 even if no row existed.
- [ ] **R13 (REQ-060)**: No code in this spec. REQ-060 is a precondition checked by `s2-dms.md` on DM send. This spec's contribution: the `friendship` and `user_block` rows are the inputs to that check. R12 + R18 are the mutations that can flip REQ-060's answer.
- [ ] **R14 (list incoming)**: `GET /api/v1/friends/requests?direction=incoming` — returns `{ requests: Array<{ id, from: { userId, username, name }, message, createdAt }> }` for rows where `toId=caller AND status='pending' AND createdAt > now()-30d` (see R7). Ordered by `createdAt` DESC. Used by REQ-136 (S2 UI).
- [ ] **R15 (list outgoing)**: `GET /api/v1/friends/requests?direction=outgoing` — same shape but with `to` instead of `from`, filtered by `fromId=caller AND status='pending' AND createdAt > now()-30d`. Needed so the requester can see "request sent" state (includes sentinel-success rows that were NOT inserted per R4 — i.e. an outgoing view will NOT show a non-existent sentinel row; the requester just sees their other pending requests. REQ-053 is explicit: "requester UI shows 'Request sent'" is *client-side* after 201).
- [ ] **R16 (REQ-073 block)**: `POST /api/v1/users/:id/block` — caller is `byId`, target is `:id`. In a single transaction: INSERT INTO `user_block` ON CONFLICT DO NOTHING (idempotent); DELETE any `friendship` row between the pair (effect 1); UPDATE any pending `friend_request` rows in either direction between the pair to `status='rejected', respondedAt=now()` (defensive: prevents a race with R2). 204. 400 if self (`byId === targetId`).
- [ ] **R17 (REQ-073 effects 3–4)**: No code here — effects 3 (B cannot send friend request to A) and 4 (B cannot initiate DM with A) are enforced on the *send* path. Effect 3 is R4 above (sentinel success). Effect 4 is the DM spec. Effect 5 (room-wide: none) is a *non*-effect — no code. Effect 6 (presence appears offline) is the presence spec.
- [ ] **R18 (REQ-074)**: `DELETE /api/v1/users/:id/ban` — removes the `user_block` row WHERE `byId=caller AND targetId=:id`. 204. Idempotent. **Does NOT restore friendship** (REQ-074 explicit). The DM unfreeze (REQ-066 auto-unfreeze iff friendship restored AND no active block) is a read-time predicate in `s2-dms.md`.
- [ ] **R19 (transverse)**: Every mutating endpoint in this spec resolves `userId` via the same `auth.api.getSession({ headers: toFetchHeaders(request) })` pattern as S1. Missing session → 401. Test per endpoint.
- [ ] **R20 (transverse)**: No endpoint returns data about a user who has blocked the caller. `GET /api/v1/friends` on Alice omits bob if bob blocked Alice (even though `friendship` is symmetric, the block deletes the row per R16 — so this is covered mechanically). The stricter rule is: the friend-request listing MUST NOT reveal "bob blocked you" via timing or response shape. Test: confirm sentinel-success (R4) is indistinguishable from a real insert at the HTTP layer (same latency bucket ±50ms, same response body shape).

## 5. Design notes

### Data model

**No schema changes required for MUST paths.** Tables already in [packages/shared/src/schema.ts](../../packages/shared/src/schema.ts):

- `friend_request` — id, fromId, toId, message, status (enum pending/accepted/rejected), createdAt, respondedAt. Unique `(fromId, toId)` — covers R6 collision semantics. Index `(toId, status)` — covers R14 incoming listing.
- `friendship` — id, userAId, userBId, createdAt. Unique `(userAId, userBId)` with the "userAId < userBId" normalization convention asserted only by comment (no CHECK). R8 MUST sort before insert.
- `user_block` — id, byId, targetId, createdAt. Unique `(byId, targetId)` — one-way, so mutual-block requires two rows. Index `targetId` — covers REQ-053 lookup ("target has blocked caller").

**Gaps (flagged, not silently fixed — see §8):**

1. `friend_request` has no `deletedAt` / `expiredAt` column. REQ-056 soft-delete via nightly sweep (S3) needs a column OR it becomes a hard DELETE in the sweep (which loses audit). Read-side filter in R7 is a workaround until a decision is made.
2. `sendFriendRequestSchema` only accepts `toUsername`. REQ-051 also allows `toUserId`. Dto change needed for full REQ-051 compliance.
3. No `friend_request_status`-partial index on `(fromId, toId, status)` — the unique index is unconditional. Collision-handling in R6 branches on `status` after a SELECT-by-unique-key. Acceptable at S2 scale; revisit if the branches show up in profiling.

### REST surface

All routes live in `apps/backend/src/routes/friendship.ts` (new file), registered under `/api/v1` in `app.ts` alongside `sessionsRoutes` and the (S1-landed) `messages.ts`.

| Route | REQ | Purpose | Req body / query | Response |
| --- | --- | --- | --- | --- |
| `GET /api/v1/friends` | REQ-050 | List accepted friends | — | `{ friends: [...] }` |
| `POST /api/v1/friends/requests` | REQ-051, 053, 054, 055 | Send / update pending request | `sendFriendRequestSchema` | 201 `{ id, status: 'pending' }` or sentinel `{ id: null, status: 'sent' }` or 200 `{ id, status: 'pending' }` on update |
| `GET /api/v1/friends/requests` | R14, R15 | List pending, filtered by direction | `?direction=incoming\|outgoing` | `{ requests: [...] }` |
| `POST /api/v1/friends/requests/:id/accept` | REQ-057 | Accept | — | 200 `{ status: 'accepted', friendshipId }` |
| `POST /api/v1/friends/requests/:id/decline` | REQ-057 | Decline | — | 200 `{ status: 'rejected' }` |
| `POST /api/v1/friends/requests/:id/block` | REQ-057 | Block from request | — | 200 `{ status: 'blocked' }` |
| `DELETE /api/v1/friends/:userId` | REQ-059 | Remove friend | — | 204 |
| `POST /api/v1/users/:id/block` | REQ-073 | Block user | — | 204 |
| `DELETE /api/v1/users/:id/ban` | REQ-074 | Unblock user | — | 204 |

All endpoints:

1. Resolve `userId` via better-auth session (R19). 401 on null.
2. Reuse the same `toFetchHeaders` pattern from S1 auth/sessions.
3. Return JSON (no HTML, no redirects). Errors follow the shape `{ error: code, ...extras }` already used in S1.
4. `bigint` not involved in any payload here — friendship/request/block use `text` id + timestamp only.

### Socket.IO surface

**One new event**: `friend.request.accepted` (REQ-058, R11).

Wire shape (proposed; see §8 Q3 for approval on adding to `protocol.ts`):

```ts
export interface FriendRequestAcceptedEvent {
  type: "friend.request.accepted";
  requestId: string;
  friendId: string;       // the user who accepted (was toId on the request)
  friendUsername: string;
  acceptedAt: string;     // ISO timestamp
}
```

Delivery: per-user private Socket.IO room `user:{userId}`, joined automatically in the existing `io.use` auth middleware right after `userId` is resolved (single line: `socket.join(\`user:\${socket.data.userId}\`)`). Emit via `io.to(\`user:\${fromId}\`).emit("friend.request.accepted", evt)` inside the R8 transaction's commit-after hook. **No watermark** on this event — it's not a room message. ADR-0003 scope is per-room message ordering; friendship notifications are at-most-once best-effort (REQ-058 doesn't require replay on reconnect).

Decline and Block emit nothing (REQ-058 explicit: "no notification is sent to the requester"). Do not add events for them.

### Blocking + DM coupling (contract with s2-dms.md)

This spec OWNS the three tables. `s2-dms.md` READS them at DM-send time:

```
can_dm(A, B) = exists(friendship where {A,B}) AND NOT exists(user_block where by=A,target=B)
                                              AND NOT exists(user_block where by=B,target=A)
```

Any change to those tables that flips `can_dm` from true to false causes subsequent DM sends to 409. The DM spec enforces; this spec just guarantees the underlying truth is current — i.e. R12 and R16 commit BEFORE returning success, so a follow-up send from the other side sees the updated state.

### Auth + room-membership reuse

Reuse the S1-landed `requireAuth` helper. No room-membership here (friendship is cross-room). For routes that take a `:userId` path param, validate format (UUID-ish or cuid — see how `user.id` is generated by better-auth) but DO NOT leak existence via 404 shape: the sentinel-success pattern (R4) is about blocked users; for genuinely unknown users, `POST /friends/requests` by username returns 404 (enumeration by username is bounded by REQ-054 rate limit).

### Rate limiting (REQ-054)

Use `@fastify/rate-limit` with a custom `keyGenerator: (req) => \`friends:\${req.user.id}\`` scoped to `POST /api/v1/friends/requests`. Limits: 20 req / 24h. Reuse the same Redis store the auth layer pins. Test via a loop that fires 21 requests in the vitest rig and asserts 429 on #21 (Redis store must be the testcontainers instance or a mock that honors the sliding window — S1 uses the container, so keep that).

## 6. Tasks (each <2h, R-numbers map to §4)

1. [ ] **Route scaffold + auth helper reuse** — `apps/backend/src/routes/friendship.ts`, registered in `app.ts` before the better-auth catch-all. Smoke test: 401 on every route without a cookie (R19).
2. [ ] **`GET /api/v1/friends` (R1 / REQ-050)** — `friends-list.test.ts`. Fixture: alice + bob friendship; assert bob appears for alice and alice appears for bob. Ordering assertion: friendedAt DESC with two rows at different timestamps.
3. [ ] **`POST /api/v1/friends/requests` happy path (R2 / REQ-051)** — `friends-send.test.ts`. Tests: valid insert, 404 on unknown username, 400 on self, dto validation edges.
4. [ ] **Sentinel-success under block (R4 / REQ-053)** — `friends-send-blocked.test.ts`. Insert `user_block(by=bob, target=alice)`; alice POSTs request to bob; assert 201 + sentinel shape + zero rows in friend_request. Timing-parity check from R20 added as a relaxed assertion (|dt|<50ms) — if flaky in CI, soften to existence-parity only with a comment.
5. [ ] **Duplicate-request branches (R6 / REQ-055)** — `friends-send-duplicate.test.ts`. Three branches: pending→UPDATE, accepted→409, rejected→UPDATE-back-to-pending. Each tests the exact resulting row state.
6. [ ] **Rate limit (R5 / REQ-054)** — `friends-send-ratelimit.test.ts`. 20 successful, 21st returns 429 with `retryAfterSec`. Uses the testcontainers Redis; resets between tests.
7. [ ] **`GET /api/v1/friends/requests` direction filter + 30d expiry filter (R14, R15, R7)** — `friends-requests-list.test.ts`. Insert rows with direction and backdated createdAt; assert filtering.
8. [ ] **Accept transaction (R8 / REQ-057 accept)** — `friends-accept.test.ts`. Fixtures: alice→bob pending request; bob accepts; assert friend_request.status='accepted', friendship row inserted with userAId < userBId, idempotent on replay.
9. [ ] **Decline (R9)** — `friends-decline.test.ts`. Status transitions to 'rejected', no friendship row, no user_block row.
10. [ ] **Block-from-request (R10 / REQ-057 block)** — `friends-block-from-request.test.ts`. Status→rejected, user_block inserted, no friendship.
11. [ ] **Socket event on accept (R11 / REQ-058)** — `friends-socket-accept.test.ts`. Second socket client connected as alice subscribes to `user:alice`; bob accepts; alice receives `friend.request.accepted` within same tick. Decline + block tests assert NO event emitted (timeout of 200ms).
12. [ ] **Remove friend (R12 / REQ-059)** — `friends-remove.test.ts`. Either party DELETEs; row gone; idempotent 204.
13. [ ] **User-to-user block (R16 / REQ-073)** — `users-block.test.ts`. POST endpoint; transaction deletes friendship, rejects pending requests, inserts user_block. Self-block → 400. Idempotent.
14. [ ] **Unblock (R18 / REQ-074)** — `users-unban.test.ts`. DELETE endpoint removes user_block only; friendship is NOT restored; idempotent 204.
15. [ ] **Protocol.ts + dto.ts additions** — BLOCKED on §8 Q1 + Q3 approval. Then: add `friend.request.accepted` event to `ServerToClientEvents`, add `toUserId` to `sendFriendRequestSchema` (or leave as username-only), add per-user room-join to socket middleware.
16. [ ] **Gate dry-run** — Manual: alice sends request to bob via REST; bob (second browser) sees it in contacts listing; bob accepts; alice's tab receives Socket event; alice removes bob; alice blocks bob; alice unblocks bob; re-friend still requires a fresh request (REQ-074 explicit).

## 7. Out of scope / follow-ups

- **REQ-056 nightly sweep** — S3 (REQ-163). This spec ships the read-side filter only.
- **`toUserId` variant of REQ-051** — blocked on §8 Q1; UI can resolve username → userId client-side for now.
- **Mutual-block symmetry** — a fully mutual block requires two rows (alice blocks bob AND bob blocks alice). REQ-073 is explicitly one-way; symmetric block is two POSTs. No API shortcut.
- **Report-abuse on friend-request messages** — REQ-051's `message` field is free text; reporting (REQ-065) applies to messages, not request notes. If abuse shows up in production, S3 can add moderation there.
- **Profile card / username display in `GET /api/v1/friends` response** — R1 returns `{ userId, username, name, friendedAt }`. If the UI needs avatar URL or last-seen, extend response or add a `/users/:id/profile` route in the S2 web spec. Do not bloat this response until the UI needs it.
- **Friend-request outgoing cancellation** — v4 REQ-051 doesn't specify cancel; REQ-055 (duplicate = UPDATE) covers re-send. If the UX wants a "Cancel request" button, add `DELETE /api/v1/friends/requests/:id` in S2 web spec. Not required by any REQ in this spec.

## 8. Open questions

Must resolve before task 3 / task 11 / task 15:

- [ ] **Q1 — `toUserId` variant (REQ-051).** v4 REQ-051 reads `{ targetUsername | targetUserId, note? }`; our `sendFriendRequestSchema` only has `toUsername`. Options:
    - **(a)** Extend DTO: `z.union([z.object({ toUsername }), z.object({ toUserId })])` — small surface, handles REQ-052's "from member panel" use case cleanly (member list already has userId).
    - **(b)** Client-side resolution: web calls `GET /api/v1/users/:id` to get username first, then POSTs with username. More round-trips; leaks a user-lookup endpoint we haven't built.
    - **Recommendation**: (a). Requires human approval (dto change — CLAUDE.md non-negotiable #5). Zero schema impact.
- [ ] **Q2 — REQ-056 TTL implementation.** `friend_request` has no soft-delete column. Options:
    - **(a)** Add `deletedAt timestamp` to `friend_request` (schema change, approval needed).
    - **(b)** REQ-056 sweep is a hard DELETE (S3 job); this spec's read-side filter on `createdAt > now()-30d` is sufficient for S2. No schema change.
    - **Recommendation**: (b). The audit argument for soft-delete is weak on pending requests (nothing happened — just abandoned). S3 can revisit if moderation needs the history.
- [ ] **Q3 — Socket event + per-user room (REQ-058).** `protocol.ts` has no `friend.request.accepted` event, and no convention for per-user rooms. Options:
    - **(a)** Add `friend.request.accepted` to `ServerToClientEvents`; add `user:{id}` room join convention (one line in socket middleware). Approval needed for protocol.ts change (frozen per CLAUDE.md #5).
    - **(b)** Drop Socket delivery; require the requester's client to poll `GET /api/v1/friends/requests?direction=outgoing` for status changes. Works without protocol change; costs a poll loop. Violates REQ-058 "requester gets a WebSocket event".
    - **Recommendation**: (a). REQ-058 is explicit. Human approval gate.
- [ ] **Q4 — Normalization of `friendship.userAId < userBId` — enforced where?** Schema comment says "normalize so userAId < userBId" but there's no CHECK constraint. Options:
    - **(a)** Add CHECK `userAId < userBId` to the migration. Belt-and-braces.
    - **(b)** Trust the R8 insert to sort. Acceptable for S2; add a code-review grep ("INSERT INTO friendship" appears in exactly one file).
    - **Recommendation**: (b) for hackathon pace. Flag in `docs/FOLLOWUPS.md` for S3 hardening.

**Contract gaps spotted (informational):**

- REQ-053 sentinel-success timing-parity is a defense-in-depth property. R20 asserts within 50ms; CI variance may flake. If it flakes twice, soften to existence-parity only with a comment citing this spec.
- `user_block` has no reason/note column. REQ-073 doesn't require one; if S3 admin tooling wants it, add then.

## 9. Gate criteria

Self-check before declaring "S2 friendship done":

- [ ] `pnpm --filter backend test:run` green — all friendship tests pass
- [ ] `pnpm trace` covers REQ-050 … REQ-060, REQ-073, REQ-074
- [ ] Manual: two browsers; alice sends request → bob sees it → bob accepts → alice's tab receives Socket event
- [ ] Block path: alice blocks bob → any pending request between them is rejected → bob sending fresh request to alice returns sentinel-success with no row
- [ ] Unblock: alice unblocks bob → friendship not restored → bob must send fresh request
- [ ] Rate-limit: 21st request in 24h returns 429

Timebox: shares the S2 soft gate at H+16 (2026-04-18 24:00 UTC) with DMs. If DM spec is the blocker for the demo and friendship is further along, ship friendship to unblock DM and call this spec done.

## 10. Acceptance test outline (REQ → test mapping)

| REQ-ID | How exercised | Layer |
| --- | --- | --- |
| REQ-050 | GET /friends returns both sides of a friendship | integration |
| REQ-051 | POST /friends/requests happy path + 404/400 | integration |
| REQ-052 | No backend test — UI concern | — |
| REQ-053 | blocker's target POSTs → sentinel, no row | integration |
| REQ-054 | 21st request in 24h → 429 | integration |
| REQ-055 | duplicate pending → UPDATE in place; rejected → UPDATE-to-pending; accepted → 409 | integration (3 branches) |
| REQ-056 | 31-day-old pending excluded from listing (read-side) | integration |
| REQ-057 | accept / decline / block request — state + side effects | integration (3 branches) |
| REQ-058 | accept emits Socket event; decline + block do not | integration (Socket.IO client) |
| REQ-059 | DELETE /friends/:userId — symmetric removal | integration |
| REQ-060 | No test here — DM spec | — |
| REQ-073 | block: friendship deleted, pending requests rejected, user_block inserted | integration |
| REQ-074 | unblock: user_block removed; friendship NOT restored | integration |
