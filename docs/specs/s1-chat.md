# Spec: S1 — Chat (messages REST + Socket.IO broadcast + seed)

**Status**: draft (2026-04-18)
**Branch**: `feat/s1-chat` (worktree at `../hackaton-s1-chat`)
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code — chat backend agent (see `.human/CHAT_AGENT_BRIEF.md`)
**Scope**: REQ-029 … REQ-041 (chat core + realtime) + REQ-049 (seed). Auth (REQ-001…REQ-019) is owned by the other agent on `feat/s1-auth` — do NOT touch it.

## 1. Why

Auth is the door; chat is the room behind it. S1's walking-skeleton gate (BRIEF.md) is "two browsers side-by-side, alice sends 'hello', bob sees it in <1s, history survives restart". That demo needs a minimal but correct slice: one REST endpoint to send, one to backfill, Socket.IO broadcast carrying the watermark, and a seed so the demo starts populated. Everything the judges see at H+10 on 2026-04-18 flows through this spec.

Correctness here is load-bearing because ADR-0003 (watermark protocol) is non-negotiable #6 in CLAUDE.md: every broadcast must carry `{seq, roomHeadSeq}`, seq must be atomic under concurrency, and no per-user durable queue may exist. Getting this wrong leaks messages on reconnect (the thing ADR-0003 exists to prevent). S2 builds on top of the watermark; retrofitting is expensive.

## 2. Non-goals

Everything below is **S2 or later** — explicitly not in this slice, called out so reviewers don't flag them:

- **DMs** (`room.kind = 'dm'`) — S2 (BRIEF.md REQ-061…REQ-066).
- **Attachments** — S2 (REQ-075…REQ-085). `sendMessageSchema.attachmentIds` exists in `dto.ts` but is **ignored** in S1 handlers.
- **Private rooms + invitations** — S2 (REQ-088, REQ-089).
- **Edit / delete message** — S2 (REQ-110…REQ-114). `message.editedAt` and `message.deletedAt` columns exist in schema but are never written by S1 handlers; `message.edited` / `message.deleted` Socket.IO events stay unused.
- **Typing indicator** — S2 soft scope (`typing` event exists in `protocol.ts`; no S1 handler).
- **Read receipts / unread counts** — S2 (REQ-120…REQ-124). `roomMember.lastReadSeq` stays at 0; no S1 endpoint updates it.
- **Per-user ban / room ban enforcement** — S2 (`roomBan` table exists; S1 does not consult it on send).
- **Presence AFK state** — S2 (REQ-099…REQ-105). S1 presence is binary online/offline only (REQ-041).
- **Room creation / management UI** — not this slice. The `general` room is created by the seed (REQ-049); no endpoint to make new rooms in S1.
- **Auth endpoints, session management, user registration** — owned by `feat/s1-auth`.

## 3. User stories

- As Alice (authenticated), I can `POST /api/v1/rooms/general/messages` with `{ body }` and the server persists it, allocates a per-room `seq`, and broadcasts it to every subscribed socket in the room. (REQ-029, REQ-030, REQ-034)
- As Alice, resubmitting the same message (same `clientMessageId`) does not create a duplicate row — the original is returned. (REQ-033) *— see §8 "Open questions" on where `clientMessageId` lives on the wire.*
- As Bob (a different browser tab subscribed to `general`), I receive `message.new` with `{seq, roomHeadSeq, message}` within the same tick as Alice's send completes. (REQ-034, REQ-040)
- As Bob, after a network blip, my client detects `roomHeadSeq > lastSeenSeq + 1` and calls `GET /api/v1/rooms/general/messages?fromSeq=…&toSeq=…` to backfill before resuming the live stream. (REQ-035)
- As Bob, when I `emit("room.subscribe", "general", ack)`, the ack carries `roomHeadSeq` so my client primes `lastSeenSeq` without an extra round-trip. (REQ-040)
- As Alice, messages persist across backend restart — reloading the page and GETting `…/messages` returns everything I sent before the restart. (REQ-036)
- As Alice, within `general` the `seq` values I observe are strictly increasing with no gaps or duplicates, even when carol and bob send concurrently. (REQ-032, REQ-037)
- As a new WebSocket client, I cannot open a connection or subscribe to a room without a valid better-auth session cookie. (REQ-038, REQ-039)
- As the demo operator, a single `pnpm db:seed` run creates `alice`/`bob`/`carol` + `general` + 3 messages, and re-running it is idempotent. (REQ-049)

## 4. Requirements (testable)

`pnpm trace` greps `tests/` for each REQ-ID. Test `describe` / `test` names MUST embed them verbatim:

```ts
describe("REQ-032 atomic seq allocation under concurrency", () => {
  test("REQ-032 100 parallel sends yield 100 unique contiguous seqs", async () => { /* ... */ });
});
```

- [ ] **R1 (REQ-029)**: `POST /api/v1/rooms/:id/messages` with a valid body (zod `sendMessageSchema`) from an authenticated member of the room inserts one `message` row, returns 201 with the `MessagePayload` shape from `protocol.ts`, and the row's `body` equals the NFC-normalized, control-char-stripped input. Body over 3072 bytes → 400 (zod). Non-member / unauth → 403 / 401 respectively.
- [ ] **R2 (REQ-030, REQ-037)**: Each successful insert advances `message_seq.seq` by 1 for that `roomId`; the new `message.seq` equals the updated `message_seq.seq`; within a room, observed `seq` values are strictly increasing.
- [ ] **R3 (REQ-031)**: Before insert, the body is passed through `.normalize("NFC")` and has control chars stripped (regex: `/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g`). A test sends a denormalized "é" (U+0065 U+0301) and a body containing `"\u0007"` and asserts the stored `body` is pure NFC without the bell.
- [ ] **R4 (REQ-032)**: Seq allocation is atomic under concurrency. Test fires 100 parallel POSTs against the same room; asserts `seqs.length === 100`, `new Set(seqs).size === 100`, and `max(seqs) - min(seqs) === 99`. The allocator MUST hold a row-level lock (`SELECT … FOR UPDATE` on `message_seq` WHERE roomId = $1) or `pg_advisory_xact_lock(hashtext(roomId))` inside the same transaction as the `INSERT INTO message`. Pick the simpler of the two that passes this test.
- [ ] **R5 (REQ-033)**: Two POSTs to the same room with the same `clientMessageId` (within the dedup window) MUST return the same `message.id` + same `seq`. No duplicate row is inserted. *— Implementation depends on §8 open question: either (a) add a `clientMessageId` column + unique index `(roomId, clientMessageId)` to `message` OR (b) dedup via a short-TTL Redis key `dedup:{roomId}:{userId}:{clientMessageId} → messageId`. Both approaches are viable; decision blocks R5.*
- [ ] **R6 (REQ-034)**: On successful insert the server emits `message.new` (see `ServerToClientEvents` in `protocol.ts`) to Socket.IO room `roomId` with `{ type: "message.new", roomId, seq, roomHeadSeq, message }`. Every field is populated; `seq === roomHeadSeq === message.seq` for this event; all three are serialized as strings (bigint→string per ADR-0003). Verified by a second Socket.IO test client that receives the event within the same tick as the POST's 201 resolves.
- [ ] **R7 (REQ-035)**: `GET /api/v1/rooms/:id/messages?fromSeq=A&toSeq=B&limit=N` returns a `HistorySliceResponse` (`{ roomId, fromSeq, toSeq, roomHeadSeq, messages }`) containing every non-deleted message with `seq` in `[A, B]`, ordered ascending by `seq`, capped at `limit` (default 50, max 200, per `historyQuerySchema`). If `fromSeq`/`toSeq` omitted, returns the newest `limit` messages and `fromSeq`/`toSeq` reflect the slice actually returned. `bigint` values are emitted as strings.
- [ ] **R8 (REQ-036)**: After `POST …/messages` succeeds, a `buildApp()` teardown + re-bootstrap still returns the message via `GET …/messages`. (Implicit in Testcontainers reuse: the Postgres container survives backend restart within the test file.)
- [ ] **R9 (REQ-038)**: A Socket.IO connection made without a valid better-auth session cookie is rejected during the handshake middleware. Test opens a client with no cookie, asserts `connect_error`. Test with a valid cookie succeeds.
- [ ] **R10 (REQ-039)**: Socket.IO heartbeat is left at Socket.IO's defaults (pingInterval 25s, pingTimeout 20s — no override needed). `connectionStateRecovery` is already configured in [socket.ts:19-22](../../apps/backend/src/socket.ts#L19-L22); spec-level ack is "default heartbeat present + `connectionStateRecovery` enabled". Asserted by reading `io.engine.opts` in a smoke test, not by timing a disconnect.
- [ ] **R11 (REQ-040)**: `socket.emit("room.subscribe", roomId, ack)` causes the server to (a) verify the caller is a member of the room (403 via `ack({ ok: false, … })` equivalent if not — see §5 "Socket.IO surface" for the exact shape, which today has no `error` field), (b) join the underlying Socket.IO room, (c) respond `ack({ ok: true, roomHeadSeq })` with the current `message_seq.seq` for the room as a string. `room.unsubscribe` leaves the Socket.IO room (no ack needed — matches `protocol.ts`).
- [ ] **R12 (REQ-041)**: Socket connect emits `presence.state` with `state: "online"` via `io.emit` (global fanout — see §8 Q2 for the S2 scoping follow-up); socket disconnect emits `state: "offline"` the same way. S1 is binary; AFK is S2. Asserted by a second socket observing the state events for the first socket's lifecycle.
- [ ] **R13 (REQ-049)**: `pnpm db:seed` (or `pnpm --filter backend db:seed`) creates `alice`, `bob`, `carol` (via `auth.api.signUpEmail` so password hashes match production), one `room` named `general` (visibility public, kind group) with all three as members, and 3 seed messages authored across the three users. Running the script twice results in no duplicate rows (idempotent: use `ON CONFLICT DO NOTHING` or pre-check by username / room name).
- [ ] **R14 (transverse)**: Every handler that mutates or reads messages takes the caller's `userId` from better-auth's session via `toFetchHeaders(request)` + `auth.api.getSession({ headers })` — the same pattern as [routes/sessions.ts:21-22](../../apps/backend/src/routes/sessions.ts#L21-L22). Missing session → 401. Verified by an integration test that hits the endpoint with no cookie.
- [ ] **R15 (transverse)**: No event path bypasses the seq allocator. Any code that emits a `message.*` event MUST read `roomHeadSeq` from the DB after allocation, never from an in-memory counter. Enforced by code review only in S1 (R4 only guards the single POST path it exercises, not any future emit site). If S2 adds a second emit site (edit/delete), a grep-based CI check — `io.to(...).emit("message.new"` appearing in exactly one file — should be added at that point.

## 5. Design notes

### Data model

**No schema changes expected** — `packages/shared/src/schema.ts` already has:

- `message` — id, roomId, authorId, `seq`, body, replyToId, editedAt, deletedAt, createdAt. Unique index `(roomId, seq)` enforces the ordering invariant at the DB level.
- `messageSeq` — per-room `seq BIGINT` counter, default `sql\`0\``. The row MUST exist before first insert (seed creates it for `general`; runtime room creation in S2 will add an upsert).
- `room`, `roomMember` — membership check reads `room_member` by `(userId, roomId)`.

**Gap flagged**: `message` has no `clientMessageId` column. REQ-033 dedup implementation depends on §8 open question. Do NOT add a column without human approval.

### REST surface

Both routes live in `apps/backend/src/routes/messages.ts`, registered under `/api/v1/rooms` in `app.ts` (ahead of the better-auth catch-all, same pattern as `sessionsRoutes`).

| Route | Purpose | REQ | Request | Response |
| --- | --- | --- | --- | --- |
| `POST /api/v1/rooms/:id/messages` | Send a message | REQ-029–034 | Body: `sendMessageSchema` (`{ body, replyToId?, attachmentIds? }`) — `attachmentIds` ignored in S1; see §8 for `clientMessageId` | 201 with `MessagePayload` |
| `GET /api/v1/rooms/:id/messages` | History + gap-fill | REQ-035 | Query: `historyQuerySchema` (`{ fromSeq?, toSeq?, limit? }`) | 200 with `HistorySliceResponse` |

Both endpoints:

1. Resolve `userId` via `auth.api.getSession({ headers: toFetchHeaders(request) })` → 401 on null.
2. Verify `room_member` has a row for `(userId, :id)` → 403 otherwise.
3. For soft-deleted messages (`deletedAt IS NOT NULL`): S1 excludes them from history responses (since delete is S2, this is a defensive filter; no test asserts it beyond "non-null query".)
4. Emit `MessagePayload` / `HistorySliceResponse` exactly as typed in `packages/shared/src/protocol.ts` — no extra fields, no spread.

### Socket.IO surface

Handlers live in `apps/backend/src/socket-handlers.ts`, wired in `server.ts` inside the `io.on("connection")` block after `createSocketIO`. Event shapes are **already typed** in `packages/shared/src/protocol.ts` — consume, do not duplicate or extend.

| Direction | Event | REQ | Contract |
| --- | --- | --- | --- |
| C→S | `room.subscribe` | REQ-040 | `(roomId, ack) => ack({ ok, roomHeadSeq })`. Server verifies membership, joins `socket` to Socket.IO room `roomId`, reads `messageSeq.seq` for the room, replies. |
| C→S | `room.unsubscribe` | — | Server calls `socket.leave(roomId)`. No ack (per `protocol.ts`). |
| S→C | `message.new` | REQ-034 | Emitted from the message send handler (in `messages.ts`, which imports the io instance) via `io.to(roomId).emit("message.new", evt)`. `evt.seq === evt.roomHeadSeq === evt.message.seq`. |
| S→C | `presence.state` | REQ-041 | Emitted on connection lifecycle. Binary online/offline only in S1. See §8 on broadcast scope. |

**Auth**: Socket.IO needs the better-auth cookie. Implementation: a `io.use(async (socket, next) => …)` middleware that reads `socket.handshake.headers.cookie`, constructs a `Headers` object, calls `auth.api.getSession({ headers })`, stashes `userId` on `socket.data.userId` if valid, rejects via `next(new Error("unauthorized"))` otherwise. Pattern mirrors `toFetchHeaders` but sourced from `handshake.headers` instead of `request.headers`.

### Seq allocation (REQ-032)

Goal: within a single SQL transaction, (a) increment `message_seq.seq` for the room, (b) INSERT into `message` using the new value, (c) return both the new `seq` and it as the new `roomHeadSeq` (they're equal for a fresh insert).

Two candidate approaches, both correct in principle:

1. **`SELECT … FOR UPDATE`** — `BEGIN; UPDATE message_seq SET seq = seq + 1 WHERE room_id = $1 RETURNING seq; INSERT INTO message (…, seq) VALUES (…, $2); COMMIT;`. The UPDATE takes a row-level lock; concurrent transactions queue on it. Simple, uses Postgres-native MVCC.
2. **`pg_advisory_xact_lock(hashtext(roomId))`** — take the advisory lock at the start of the tx, do both writes, commit. Lock auto-releases at commit. Slightly cheaper than a row update lock because no row is modified to hold the lock.

Pick approach 1 first (it's the drizzle-natural pattern — `.update(messageSeq).set({ seq: sql\`seq + 1\` }).where(eq(messageSeq.roomId, …)).returning()` inside `db.transaction`). If the concurrency test (R4) fails at 100 parallel sends or shows lock contention >500ms, switch to advisory lock. The test IS the gate for this decision — do not pre-optimize.

### clientMessageId idempotency (REQ-033)

See §8 — the wire/schema shape is an open question. Two acceptable strategies:

- **(a) DB-level**: add `clientMessageId TEXT` column + unique index `(roomId, clientMessageId)` on `message`; on insert, catch the unique-violation and SELECT the existing row by `(roomId, clientMessageId)` to return it. Survives restarts. Requires schema change + dto change → blocked on approval.
- **(b) Redis-level**: `SETNX dedup:{roomId}:{userId}:{clientMessageId} -> messageId EX 300`. Cheap, no schema change, 5-minute dedup window. Loses dedup on Redis flush. Does NOT require touching `schema.ts` or `dto.ts` if `clientMessageId` is sent as a header (e.g. `Idempotency-Key`), but that's still a contract decision.

R5 waits on the human's pick.

### Unicode hygiene (REQ-031)

Applied at the Fastify handler layer, **after** zod parse and **before** the allocator transaction. Single helper `normalizeBody(s: string): string` in `apps/backend/src/lib/message-text.ts`:

```
return s.normalize("NFC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
```

Line feed (`\n`, U+000A), tab (`\t`, U+0009), and carriage return (U+000D) are preserved — the regex excludes them by range. Tests live next to the helper as unit tests (REQ-031 tagged) — the helper is pure, no DB needed.

### Auth integration

Reuse the auth-to-userId pattern from `routes/sessions.ts`:

```ts
const headers = toFetchHeaders(request);
const me = await auth.api.getSession({ headers });
if (!me) return reply.status(401).send({ error: "unauthorized" });
const userId = me.user.id;
```

Wrap this + the room-membership check into a single helper `apps/backend/src/lib/message-auth.ts` so both `POST` and `GET` call it. No new better-auth config, no session-storage changes. The helper's signature: `requireRoomMember(request, reply, roomId): Promise<{ userId: string } | null>` — returns `null` after sending the 401/403 so the caller just `if (!ctx) return;`.

### Seed (REQ-049)

Script at `scripts/seed.ts` (repo root, invoked via `pnpm db:seed` after adding the package.json entry). Steps:

1. Use `auth.api.signUpEmail({ body: { email, password, name, username } })` for `alice@herders.local` / `bob@herders.local` / `carol@herders.local`, password `hunter2hunter2` (≥8 chars, matches registerSchema). Verified 2026-04-18: `username` is accepted in the body via `additionalFields.username` ([auth.ts:24-26](../../apps/backend/src/auth.ts#L24-L26)) AND is a queryable column on the `user` table ([schema.ts:55](../../packages/shared/src/schema.ts#L55), `notNull().unique()`). Skip per-user if the username already exists (pre-check: `db.select().from(user).where(eq(user.username, "alice")).limit(1)`).
2. Upsert `room` with `id: "general"`, `name: "general"`, `kind: "group"`, `visibility: "public"`, `ownerId: alice.id`. ON CONFLICT DO NOTHING.
3. Upsert `message_seq` row for the general room. ON CONFLICT DO NOTHING.
4. Upsert `room_member` rows for all three users. ON CONFLICT (via the `room_member_user_room_uq` index) DO NOTHING.
5. If `message` table has zero rows for `general`, insert 3 seed messages through the same seq allocator the runtime uses (import and call it) so seq starts at 3. If rows exist, skip.
6. Exit 0. Re-running produces no new rows.

The script must NOT use raw SQL bypassing the allocator in step 5 — that's the whole point of non-negotiable #6.

## 6. Tasks (each <2h, R-numbers map to §4)

1. [ ] **Test rig warmup** — Confirm Testcontainers + `apps/backend/tests/setup.ts` + `db-helpers.ts` work against `messages` / `message_seq` / `room_member` tables. One green smoke test that inserts a row via drizzle and reads it back. (No REQ tag — rig only.)
2. [ ] **Unicode helper + unit tests (R3, REQ-031)** — Write `apps/backend/src/lib/message-text.ts` + `message-text.test.ts`. Red → green first because this is pure + unblocks R1.
3. [ ] **`message-auth.ts` helper + integration test (R14)** — `requireRoomMember(request, reply, roomId)`. Test covers: no cookie → 401, valid cookie + non-member → 403, valid cookie + member → returns `{ userId }`.
4. [ ] **Seq allocator + concurrency test (R2, R4 / REQ-030, REQ-032, REQ-037)** — Write `messages-seq-concurrency.test.ts` FIRST (100 parallel sends, asserts uniqueness + contiguity). Implement `apps/backend/src/lib/seq-allocator.ts` with `SELECT … FOR UPDATE`. If the test fails under load or times out, swap to `pg_advisory_xact_lock`. Commit the approach that passes — decision is empirical.
5. [ ] **`POST /api/v1/rooms/:id/messages` (R1 / REQ-029)** — `messages-send.test.ts` covers happy path, 400 on oversize body, 401 unauth, 403 non-member, NFC+control-char normalization end-to-end (not just helper). Registers route in `app.ts`.
6. [ ] **`GET /api/v1/rooms/:id/messages` (R7, R8 / REQ-035, REQ-036)** — `messages-history.test.ts` covers: no params → newest N, fromSeq/toSeq slicing, limit cap at 200, bigint-as-string on the wire, survives a `buildApp()` re-bootstrap.
7. [ ] **Socket.IO handlers + subscribe/unsubscribe (R6, R11 / REQ-034, REQ-040)** — `socket-handlers.ts` with `room.subscribe` (membership check, join, ack with `roomHeadSeq`) and `room.unsubscribe`. Wire the send handler to emit `message.new` via `io.to(roomId).emit(...)`. `socket-subscribe.test.ts` covers ack shape + broadcast delivery to a second client within the same tick.
8. [ ] **Socket.IO auth middleware (R9 / REQ-038)** — `io.use(...)` reads handshake cookie, calls `auth.api.getSession`, stashes `userId`. Test: connect without cookie → `connect_error`; with cookie → connected.
9. [ ] **Heartbeat + presence lifecycle (R10, R12 / REQ-039, REQ-041)** — Assert Socket.IO defaults (`pingInterval 25s`, `pingTimeout 20s`) via `io.engine.opts`. Emit `presence.state` on connect/disconnect. Broadcast scope: `io.emit` globally in S1 (simple; §8 open question flags whether to scope to rooms the user is in). Test: two sockets; socket A observes socket B's online→offline transition.
10. [ ] **clientMessageId idempotency (R5 / REQ-033)** — BLOCKED on §8 decision. Implement either (a) schema+dto change + DB-unique dedup or (b) Redis `SETNX` dedup once the human picks. `messages-idempotency.test.ts` covers: same `clientMessageId` sent twice → same `message.id` + same `seq` + one row.
11. [ ] **Seed script (R13 / REQ-049)** — `scripts/seed.ts` + `pnpm db:seed` in `apps/backend/package.json`. Idempotency test: run it twice via `pnpm db:seed`, assert user/room/message counts match between runs.
12. [ ] **Gate dry-run** — Manual: two browsers (or two sockets in a single test) subscribe to `general`, one sends, the other receives < 1s; restart backend (`buildApp` recreate in a test); history endpoint still returns all messages. Checklist in §9.

## 7. Out of scope / follow-ups

- **DMs, attachments, private rooms, edit/delete, typing, read receipts, AFK presence, room ban enforcement, room creation endpoint** — all S2 per BRIEF.md.
- **`connectionStateRecovery` hard-verify** — `socket.ts:19` enables it with a 2-minute window; S1 trusts it. An S3 task could add a "drop packets mid-flight, expect replay" e2e.
- **Moderation audit log on send** — S3 (REQ-165 is deferred; BRIEF.md keeps it out of hackathon scope).
- **Message rate-limit per user** — S3 (`@fastify/rate-limit`). S1 trusts the auth-layer rate limiter already pinned in `auth.ts`.
- **`lastReadSeq` writebacks** — S2 unread-counts feature.
- **`attachmentIds` processing** — field accepted by `sendMessageSchema` but ignored in S1. When S2 lands attachments, the ignore becomes a "link attachment rows to the message" in the same transaction.
- **Presence broadcast scoping** — S1 uses `io.emit` globally. S2 may scope to "rooms the subscriber and subject share" for privacy + bandwidth.

## 8. Open questions

**Must be resolved before the chat agent starts task 5 / task 10:**

- [ ] **`clientMessageId` — where does it live on the wire, and where is dedup enforced?** Neither `sendMessageSchema` (`packages/shared/src/dto.ts`) nor the `message` table (`packages/shared/src/schema.ts`) has a `clientMessageId` field, but REQ-033 explicitly requires idempotent re-submits. Options:
    - **(a)** Add `clientMessageId: z.string().uuid().optional()` to `sendMessageSchema` + `clientMessageId text` column + unique index `(roomId, clientMessageId)` on `message`. Durable, survives restart. Requires schema + dto changes (both "frozen" per CHAT_AGENT_BRIEF; need approval).
    - **(b)** Pass `clientMessageId` as an HTTP header `Idempotency-Key`; dedup via Redis `SETNX` with 5-minute TTL storing `messageId`. No schema/dto change. Loses dedup on Redis flush; dedup window bounded.
    - **(c)** Add only to DTO (client-side generated UUID in the POST body) + Redis dedup (no DB column). Schema unchanged, dto minimally extended. **Non-durable**: dedup is lost on Redis flush and past the 5-minute TTL, so a user who double-submits after a ≥5-min pause (or after a Redis restart) WILL get duplicate rows. Acceptable for the 24h demo; frontend agent must NOT design UI assuming durable dedup.
    - **Recommendation**: (c). DTO extension is a soft break; schema stays untouched; Redis dedup is cheap and the 5-minute window matches realistic double-click/retry behavior. Tradeoff above called out explicitly so the frontend agent doesn't build on a false assumption.
- [ ] **`presence.state` broadcast scope (REQ-041).** `protocol.ts` defines the event shape but not the fanout scope. Option (a): global `io.emit` — simple, leaks everyone's online status to everyone (acceptable for a single-room S1 demo). Option (b): emit only to rooms the subject is a member of — correct long-term, more code. S1 recommendation: (a), defer (b) to S2 alongside DM privacy work.
- [ ] **Subscribe-ack error shape.** `protocol.ts` types the ack as `{ ok: boolean; roomHeadSeq: string }` — no `error` field. If the caller isn't a member, do we (a) ack `{ ok: false, roomHeadSeq: "0" }` and silently skip the join, or (b) push an `error` field to `protocol.ts` (contract change)? S1 recommendation: (a) — matches the frozen type; frontend agent decides UX from `ok: false`.

**Contract gaps spotted (informational — flagged for cross-agent awareness):**

- `message.replyToId` is accepted by `sendMessageSchema` but has no FK validation in S1 (no test asserts "reply to non-existent id → 400"). Left as-is for S1; S2 edit/delete will exercise this path.
- `PROTOCOL_VERSION = 1` in `protocol.ts` is never checked at handshake. S3 can add a version negotiation if judges ask.

## 9. Gate criteria (copied from `.human/CHAT_AGENT_BRIEF.md`)

Self-check before declaring "S1 chat done":

- [ ] `pnpm --filter backend test:run` green — all chat tests pass
- [ ] `pnpm trace` shows coverage for every REQ-ID listed under "Deliverables" (REQ-029…REQ-041, REQ-049)
- [ ] Manual: two clients subscribed to `general`; both receive message within same tick; restart backend; history endpoint returns the message
- [ ] Seq concurrency test: 100 parallel sends → 100 unique contiguous seqs
- [ ] Kill a client mid-stream, let the other send 3 messages, reconnect; `roomHeadSeq - lastSeen` triggers a history fetch that returns the missing 3 in order
- [ ] Seed script creates `alice`/`bob`/`carol` + `general` idempotently

Timebox: S1 gate is H+10 from hackathon start (2026-04-18 08:00 UTC) → **2026-04-18 18:00 UTC**. Past H+8 with send + seq + broadcast working but history gap-fill incomplete, ship what works and flag the gap — do not yak-shave.

## 10. Acceptance test outline (REQ → test mapping)

| REQ-ID | How exercised | Layer |
| --- | --- | --- |
| REQ-029 | POST happy path + oversize 400 + unauth 401 + non-member 403 | integration |
| REQ-030 | seq advances by 1 per insert | integration |
| REQ-031 | NFC + control-char strip (helper unit + end-to-end) | unit + integration |
| REQ-032 | 100 parallel sends → unique contiguous seqs | integration (concurrency) |
| REQ-033 | same clientMessageId → same message.id + same seq | integration (blocked on §8) |
| REQ-034 | second socket receives `message.new` with {seq, roomHeadSeq} within same tick | integration (Socket.IO client) |
| REQ-035 | history fromSeq/toSeq slicing + limit cap + bigint-as-string | integration |
| REQ-036 | messages survive `buildApp()` re-bootstrap | integration |
| REQ-037 | strictly increasing seq asserted by R2's test ordering | integration (shared with R2) |
| REQ-038 | connect without cookie → `connect_error` | integration (Socket.IO) |
| REQ-039 | engine pingInterval/pingTimeout defaults present | smoke |
| REQ-040 | `room.subscribe` ack returns `roomHeadSeq` | integration (Socket.IO) |
| REQ-041 | two-socket presence online→offline observation | integration (Socket.IO) |
| REQ-049 | seed creates three users + general + 3 messages; re-run is idempotent | integration |
