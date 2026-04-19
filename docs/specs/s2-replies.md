# Spec: S2 — Message replies (quoted parent preview)

**Status**: approved (2026-04-19) — Qs resolved: Q1=LIVE, Q2=collapsed `reply_parent_invalid`, Q3=scoped `RoomClient.tsx` edit (R11+R15 only, no refactor), Q4=`protocol.ts`.
**Branch**: `feat/replies` — worktree at `../hackaton-replies` off `main` @ `c84948c`
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code — Agent C, wave1 (parallel with A=room-mgmt, B=invitations)
**Binding source of truth**: v3.docx §2.5.2 (message content may reference another message) + §2.5.3 (replied-to message visually outlined or quoted) + Appendix A (visual target). Ancillary REQ-ID hooks for `pnpm trace`: REQ-110 (Reply to message) + REQ-133 (Reply composer) from `/task/Chat_Server_Requirements_v4.md`.

## 1. Why

The chat MVP today has no way to pin a message to a specific antecedent. Two users talking past each other in a 300-person room can't make "you meant *which* message" explicit. v3.docx §2.5.3 calls for a visual quote block (Appendix A format: `Carol replied to Bob: > Hello team / Can we make this private?`). The wave1 carve on `main` (`c84948c`) already reserved the DB column (`message.reply_to_id`) and left a note on `protocol.ts:184` that replies reuse `message.new` — so the wire shape is settled and this spec ships everything that sits on top.

Scope choice driven by the brief: extend the existing send path, history hydration, and Socket.IO broadcast shape — do NOT add a new event, do NOT add a migration, do NOT touch edit/delete handler semantics. Rooms + DMs get replies simultaneously via `toMessagePayload` because DM `lastMessage` already flows through that serializer.

## 2. Non-goals

Explicit, so reviewers don't flag:

- **New Socket.IO events for replies** — `message.new` carries the reply via a new optional `replyTo` field on `MessagePayload` (carved on `main` already; see `protocol.ts:184`). No `message.reply.added`.
- **DB migration** — `message.reply_to_id text` exists ([schema.ts:254](../../packages/shared/src/schema.ts#L254)); no new columns, no new indexes. Any design that requires persisted snapshot body columns is out (flagged in §8 Q1).
- **Editing / deleting replies differently from any other message** — REQ-110/REQ-112 handlers in [messages.ts:436-620](../../apps/backend/src/routes/messages.ts#L436-L620) already soft-delete + edit by messageId. Replies are messages; no branch. The brief is explicit: "do NOT touch edit/delete handlers beyond making their responses include `replyTo` pass-through."
- **Threaded / nested conversations** — `reply_to_id` is a single hop (one parent per message). A reply-to-a-reply yields a flat list of two replies, each pointing at its parent. No thread view, no "show all replies to this message" affordance.
- **Thread collapse / notification-on-reply** — v4 REQ-110 stops at the preview block; no per-thread unread, no "you were replied to" indicator.
- **Jump-to-parent scroll behavior** — cut per brief kill-switch #1; see §7 follow-ups. Static quote render is the MVP.
- **DM-specific reply UI** — DMs are group rooms with `kind='dm'` (ADR-0007). Reply flows identically through the shared send path; the DM listing's `lastMessage` passes `replyTo` through `toMessagePayload` automatically.
- **Room-mgmt and invitation protocol events** — agents A/B own those per the wave1 carve. This spec only touches `MessagePayload` in `protocol.ts` (the `replyTo` field); it does NOT fill in any of the reserved `room.*` payload stubs.
- **Attachments-on-replies parity** — replies can carry attachments identically to any message (shared send path). No new wiring needed; no new tests beyond existing attachment coverage.

## 3. User stories

- As Alice, I can hover any message in a room I'm in, click **Reply** in the actions menu, and a chip `[Replying to: {username} ×]` appears above my composer. My next send carries `replyToId` and renders to everyone as a quoted block above my message body. (v3.docx §2.5.3 + Appendix A; REQ-133)
- As Alice, I can click `×` on the reply chip to clear the reply-to state; my next send is a plain message with no `replyToId`. (REQ-133)
- As Bob in the same room, I see Alice's reply render with a subtle left-bordered quote block showing the parent's author + first ~120 chars, above her message body. Clicking the quote block does nothing in MVP (kill-switch #1 cut). (v3.docx §2.5.3 / Appendix A)
- As Alice, the parent I'm replying to is validated server-side: the parent must exist AND must belong to the same room. If I somehow submit a `replyToId` pointing at another room's message — e.g. from a stale composer state after switching rooms — I get `400 { error: "reply_cross_room" }` and no message is created. (Brief anti-cross-room-leak contract, critical.)
- As Alice, if my room access was revoked between opening the composer and hitting send (ban/kick), I get `403 { error: "not_room_member" }` from the existing membership gate — the reply never lands. (Reuse of `requireRoomMember`; no new code path.)
- As Alice, I can still reply to a message whose author just soft-deleted it. My reply lands; the quoted block renders `[deleted]` in place of the parent body. (Brief §2 design note: "If parent `deletedAt` is non-null at send time, still allow the reply.")
- As Alice, replies work the same in DMs. Bob and I have a DM; I Reply to his "hi" with "hey" and the quoted block renders identically.
- As a history-loader (gap-fill on reconnect), replies in the slice include the `replyTo` preview so the quote block renders without N+1 round-trips. (Brief §2: "one join, not N+1.")

## 4. Requirements (testable)

`pnpm trace` greps `tests/` for REQ-IDs in test names — REQ-110 + REQ-133 carry the bulk here. Each R maps to exactly one `it(...)` unless flagged.

- [ ] **R1 (REQ-133 DTO)**: `sendMessageSchema` in [dto.ts:59-67](../../packages/shared/src/dto.ts#L59-L67) already has `replyToId: z.string().optional()`. **Tighten** to `z.uuid().optional()` so malformed ids never reach the DB. Add a zod test: `{ body: "hi", replyToId: "not-a-uuid" }` → 400 validation. `{ body: "hi", replyToId: <valid uuid> }` → parse succeeds; `{ body: "hi" }` (omitted) → parse succeeds. No change to the backend `SendBody` runtime type except the UUID narrowing.
- [ ] **R2 (REQ-110 parent exists)**: On `POST /api/v1/rooms/:id/messages` with `replyToId` present, the send handler MUST `SELECT id, room_id, deleted_at, author_username, body FROM message WHERE id = :replyToId LIMIT 1` BEFORE allocating seq. If no row → `400 { error: "reply_parent_invalid" }` (collapsed code per Q2), no row created, no seq consumed. (The existing membership check runs first; seq allocator is untouched.)
- [ ] **R3 (REQ-110 cross-room block — SECURITY)**: If the parent row exists but `parent.room_id !== :roomId`, return `400 { error: "reply_parent_invalid" }` — SAME code as R2's not-found branch (Q2 collapsed). No seq consumed, no insert, no broadcast. **This is the anti-information-leak test** — a caller must not be able to distinguish "not found" from "wrong room" via error code; matches `messages.ts:492` precedent where `message_not_found` also covers cross-room. Test covers: (a) parent in different group room → 400 reply_parent_invalid, (b) parent in a DM the caller is NOT a member of → 400 reply_parent_invalid (do NOT leak "not found" vs "forbidden"), (c) parent in the same room → allowed. All three assertions read the same error string.
- [ ] **R4 (REQ-110 deleted-parent allowed — contract-only, UX-unreachable)**: If parent exists in the same room and `parent.deleted_at IS NOT NULL`, the send proceeds normally — insert with `replyToId` persisted, broadcast `message.new`. The `replyTo` payload field for this send carries `deletedAt: <ISO timestamp>` (non-null) and `text: ""` (empty; the renderer shows `[deleted]`). Test: soft-delete a parent directly via the delete handler, then reply to it; assert 201, `replyTo.deletedAt !== null`, `replyTo.text === ""`. **UX-path note**: R13 hides the Reply button on soft-deleted messages, so the user cannot initiate this in the UI — R4 is a **contract test** guarding the API against stale-UI replays (composer opened before delete → delete landed → user hits Send). Worth preserving so the handler has a defined behavior and doesn't throw or 500 on the race. The "reply-to-deleted" bullet in the brief's demo smoke is about a quoted block that FLIPS to `[deleted]` after the reply is already sent (R11), not about initiating a new reply to an already-deleted parent.
- [ ] **R5 (REQ-110 payload shape on send)**: `message.new` broadcast + HTTP response body include `replyTo` when `replyToId` present, `replyTo: null` otherwise. Shape (added to `MessagePayload` in [protocol.ts:31-53](../../packages/shared/src/protocol.ts#L31-L53)):
    ```ts
    replyTo: {
      id: string;
      text: string;           // parent body, truncated server-side to PREVIEW_MAX chars (§5)
      authorUsername: string; // read from parent.author_username (naturally snapshot — denormalised)
      deletedAt: string | null; // ISO if parent currently soft-deleted, else null
    } | null
    ```
    Test: send with `replyToId` → response has `replyTo.id === parentId`, `replyTo.text === <truncated parent body>`, `replyTo.authorUsername === <parent sender's username at parent-send time>`, `replyTo.deletedAt === null`. Send without → `replyTo === null` (the key MUST be present; serializer emits null explicitly).
- [ ] **R6 (REQ-110 history hydration — one JOIN, no N+1)**: `GET /api/v1/rooms/:id/messages` LEFT JOINs `message` to itself on `m.reply_to_id = parent.id`, selecting `parent.id`, `parent.body`, `parent.author_username`, `parent.deleted_at` in the same query. The serializer populates `replyTo` for rows where `reply_to_id IS NOT NULL`. Attachment loading path is unchanged. Test: seed 5 messages, 3 of them replies (2 to the same parent, 1 to a different parent); GET history; assert all 5 rows present; the 3 replies have populated `replyTo`; the 2 non-replies have `replyTo: null`. **Round-trip assertion**: instead of spying on ORM internals (brittle), capture `pg` statements via the Drizzle logger (`logger: (query) => capturedQueries.push(query)` on the test db client) or by wrapping the pool with a query-capturing proxy; assert (a) exactly ONE `SELECT ... FROM "message" ... LEFT JOIN "message" ...` fires for the history path (ignore attachments/author-deletion followups, which are separate existing queries), and (b) the message query text contains `left join` once (case-insensitive). This asserts the SQL shape, not the ORM call count.
- [ ] **R7 (server-side truncation)**: Parent preview text is truncated server-side to `PREVIEW_MAX = 120` UTF-16 code units. If `parent.body.length > 120`, the payload's `replyTo.text` is `parent.body.slice(0, 120) + "…"` (single Unicode horizontal-ellipsis U+2026). If ≤ 120, passed verbatim. Test: parent body of 500 chars → `replyTo.text.length === 121` (120 + ellipsis) AND endsWith `"…"`. Parent body of 50 chars → `replyTo.text === parent.body` unchanged. Kill-switch #3 cuts this to client-side only — tradeoff noted in §7.
- [ ] **R8 (REQ-110 DM parity)**: Replies in a DM room work identically. Same send handler, same history handler, same `message.new` event. The DM listing's `lastMessage` in `GET /api/v1/dms` ([dms.ts:412](../../apps/backend/src/routes/dms.ts#L412)) already flows through `toMessagePayload`, so `replyTo` propagates automatically. Test: open a DM, alice sends "hi", bob replies with `replyToId=alice.messageId`; assert bob's reply has `replyTo` populated; `GET /api/v1/dms` for alice returns the DM with `lastMessage.replyTo` populated.
- [ ] **R9 (REQ-110 no change to edit/delete semantics)**: `PATCH /api/v1/rooms/:id/messages/:messageId` and `DELETE /.../:messageId` are unchanged in behavior. The only allowed response-shape change: serialized response passes through `replyTo` on the returned `MessagePayload` if the edited/deleted message itself was a reply. Test: send a reply; edit its body; assert the edit response includes `replyTo` (same parent, unchanged); the `message.edited` socket event body does NOT carry `replyTo` (it only carries `{messageId, body, editedAt}` per existing [protocol.ts:63-71](../../packages/shared/src/protocol.ts#L63-L71); field not added).
- [ ] **R10 (REQ-110 parent-edit live-drift semantics — Q1 LIVE)**: When a parent message is edited via `PATCH`, the broadcast + HTTP response for **already-sent replies** does NOT emit a refreshed `replyTo.text`. On next history GET for those replies, the `replyTo.text` WILL reflect the new parent body (LEFT JOIN reads live `parent.body`). **Mechanism for "in-memory unchanged"**: no server code actively freezes the preview — the invariant holds because (i) no `message.edited` event carries a `replyTo` update, and (ii) the FE reducer for `message.edited` in `RoomClient` mutates only the target message's `body` + `editedAt`, not any other row's `replyTo`. Test (client reducer unit test, NOT a Playwright round-trip): construct a state object with two messages — parent `P` body "hello team", reply `R` with `replyTo = { id: P.id, text: "hello team", ... }`; feed a `message.edited` event for `P` with `body: "hello everyone"`; assert the reduced state has `P.body === "hello everyone"` AND `R.replyTo.text === "hello team"` (unchanged). Then for the server-side half: GET history → assert `R.replyTo.text === "hello everyone"` now (live hydration on refresh — the documented Q1 drift). Two assertions, two environments, one R.
- [ ] **R11 (REQ-110 parent-delete live-flip)**: When a parent is soft-deleted via `DELETE /api/v1/rooms/:id/messages/:parentId`, the existing `message.deleted` event fires. The **web client** MUST listen for this event and, for every in-memory message where `replyTo.id === messageId`, set that row's `replyTo.deletedAt` to the event's `deletedAt` and `replyTo.text` to `""`. This is the ONLY FE-side cross-message reactive wiring in this spec. Test: (a) server-side — reply to parent P1, soft-delete P1, refresh history, assert `replyTo.deletedAt !== null` and `replyTo.text === ""`; (b) client-side — unit test the reducer / event handler that processes `message.deleted` and mutates matching replies (§5 FE state).
- [ ] **R12 (REQ-133 composer UI — Reply chip)**: `MessageComposer.tsx` gains a `replyTo?: { messageId, authorUsername }` prop. When present, render above the textarea: `[Replying to: {authorUsername} ×]` per Appendix A. Clicking `×` calls a new `onClearReply` prop. `send()` passes `replyToId` as part of the `onSend` callback signature: change `onSend: (body: string, attachmentIds?: string[]) => ...` → `onSend: (body: string, attachmentIds?: string[], replyToId?: string) => ...`. Tests (Vitest + Testing Library): chip renders when prop is set; `×` click fires `onClearReply`; Enter-submit calls `onSend` with the `replyToId` as the 3rd positional arg; when prop is undefined, no chip, `onSend` is called with `replyToId` undefined (no regression on existing tests).
- [ ] **R13 (REQ-133 MessageActions — Reply action)**: `MessageActions.tsx` gains an `onReply?: () => void` prop. When supplied, renders a "Reply" button alongside Edit / Delete (ordered: Reply, Edit, Delete). Reply is visible **on every message regardless of authorship** — v3.docx §2.5.3 doesn't restrict replies to own messages; you reply to what someone else said, typically. Visibility rules existing for Edit/Delete (author-only, not-deleted) are unchanged; Reply is visible on messages as long as `onReply` is supplied AND the message is not soft-deleted. Tests: renders Reply when prop supplied; click fires `onReply`; hidden when `onReply` undefined (preserves legacy callers).
- [ ] **R14 (REQ-110 MessageList quoted block render)**: `MessageRow` in [MessageList.tsx:142-218](../../apps/web/src/components/chat/MessageList.tsx#L142-L218) renders a quoted block above `message.body` when `message.replyTo !== null`. Visual: subtle left-border (`border-l-2 border-muted-foreground/30`), small italic-ish text (`text-xs italic opacity-80`), 1-line truncation on overflow (Appendix A visual target). Content: if `replyTo.deletedAt !== null` → `[deleted]`; else → `{replyTo.authorUsername}: {replyTo.text}`. The block is NOT interactive in MVP (kill-switch #1 cut). Tests: render a message with `replyTo` populated, assert quoted-block DOM with text. Render with `replyTo.deletedAt` set, assert `[deleted]`. Render with `replyTo: null`, assert no quoted block DOM.
- [ ] **R15 (REQ-110 wave1 Reply end-to-end)**: `RoomClient.tsx` (or equivalent page container — TBD during implementation; not in brief's "you own" list but the wiring must land somewhere) wires `onReply` → sets local `replyTo` state → passes to composer; `onClearReply` → clears state; `onSend(..., replyToId)` → attaches to fetch body; parent-delete socket event → reducer updates all affected replies' `replyTo` fields. This is the glue; spec flags that one file outside the brief's "You own" list (likely `RoomClient.tsx`) needs a small edit — §8 Q3 for approval, see Appendix A of the brief for visual target.
- [ ] **R16 (deterministic idempotency across reply state)**: Existing REQ-033 idempotency ( `clientMessageId` partial unique on `(room_id, client_message_id)`) is orthogonal to replies — a duplicate retry with same `clientMessageId` returns the prior row including its then-saved `replyToId` (which the allocator already persists). Test: send with replyToId + clientMessageId; re-send same payload; assert returned row id is identical and `replyTo` matches; no new message_seq consumed.
- [ ] **R17 (no-op on broadcast when deduped)**: If the allocator short-circuits on dedup (existing behavior: `deduped=true` → skip broadcast, see [messages.ts:290-305](../../apps/backend/src/routes/messages.ts#L290-L305)), the `message.new` event is NOT re-emitted. Reply-with-dedup inherits this behavior without new code; test asserts no `message.new` event fires on the duplicate send.

## 5. Design notes

### Data model

**Zero schema changes.** `message.reply_to_id text` ([schema.ts:254](../../packages/shared/src/schema.ts#L254)) is the only persistence. No FK constraint at DB level — the handler validates parent existence + same-room at app layer (R2 + R3). Rationale (carved on `main`): a self-referential FK with `ON DELETE SET NULL` would erase `reply_to_id` on parent hard-delete; we use soft-delete so the FK would be fine, BUT we never hard-delete messages (only soft-delete via `deleted_at`). No FK keeps migration surface zero. App-layer validation costs one extra SELECT per reply send — O(1), indexed by primary key — acceptable.

**`replyTo.authorUsername` is naturally snapshot** via the existing denormalisation: `message.author_username` is frozen at send time (Slack/Discord audit semantics, see comment at [schema.ts:242-244](../../packages/shared/src/schema.ts#L242-L244)). So reading `parent.author_username` at reply-hydration time returns the author's name *as it was when the parent was sent* — even if the author later renamed. Free snapshot.

**`replyTo.text` is LIVE**, not snapshotted, because no column stores the snapshot and the brief forbids migrations. §8 Q1 is the deviation from the brief's "send-time snapshot" phrasing. See R10.

**`replyTo.deletedAt` is LIVE** by design — the whole point is to flip to `[deleted]` on parent soft-delete. This is consistent with the brief's smoke scenario.

### REST surface

**Zero new routes.** The existing 3 endpoints are mutated:

| Route | Mutation |
| --- | --- |
| `POST /api/v1/rooms/:id/messages` | R2/R3/R4 parent validation; R5 `replyTo` in response |
| `GET /api/v1/rooms/:id/messages` | R6 LEFT JOIN + hydration |
| `PATCH /api/v1/rooms/:id/messages/:messageId` | R9 `replyTo` in response (pass-through; no behavior change) |
| `DELETE /api/v1/rooms/:id/messages/:messageId` | no change; the broadcast event already carries `messageId` which is enough for FE to flip matching replies |

DM routes at [dms.ts](../../apps/backend/src/routes/dms.ts) are unchanged; `toMessagePayload` in messages.ts is the single serializer used by both and carries the `replyTo` field for free once it's added there.

### Socket.IO surface

**Zero new events.** `message.new` in [protocol.ts:55-61](../../packages/shared/src/protocol.ts#L55-L61) carries the extended `MessagePayload` which now includes optional `replyTo`. The note at [protocol.ts:184-185](../../packages/shared/src/protocol.ts#L184-L185) confirms this carve.

`message.edited` is NOT extended — R9 scopes edit to body/editedAt only. `message.deleted` is unchanged — FE handler (R11) looks up in-memory messages whose `replyTo.id` matches and mutates locally. No server-driven reply-refresh event.

### Server-side truncation constants

Place in a new exports-block in `packages/shared/src/protocol.ts` (or `dto.ts` — §8 Q4):

```ts
export const REPLY_PREVIEW_MAX = 120;
export const REPLY_PREVIEW_ELLIPSIS = "…";
```

Used by the backend serializer AND (if client-side truncation replaces it per kill-switch #3) by the web renderer. Keeping the constants in `packages/shared` avoids drift between server and client.

### Serializer change

Extend `toMessagePayload` in [messages.ts:122-141](../../apps/backend/src/routes/messages.ts#L122-L141). New signature:

```ts
export function toMessagePayload(
  row: Message,
  authorDeleted = false,
  parent?: {
    id: string;
    body: string;
    authorUsername: string;
    deletedAt: Date | null;
  } | null,
): MessagePayload
```

`parent === undefined` → caller does not know; `replyTo = null` in output (back-compat for callers that don't hydrate, e.g. the DM listing's `latestByRoom` path — which WILL need an update per R8, tracked as task 9). `parent === null` → caller knows there's no parent; output `replyTo: null`. `parent === <row>` → output populated `replyTo` (truncate text per R7, ISO deletedAt).

### Hydration helper

New file: `apps/backend/src/lib/reply-preview.ts`. Exports:

```ts
export function previewFromParent(row: { id: string; body: string; authorUsername: string; deletedAt: Date | null }): MessagePayload["replyTo"];
```

Handles truncation + ISO conversion + `[deleted]` text substitution (`text: ""` when `deletedAt !== null`). Called from 3 sites: send handler (R5), history handler (R6 via batched join result), DM listing (R8 via batched fetch of parent rows for each lastMessage with `reply_to_id`).

### FE — parent-delete reactive handler (R11)

Add to the existing `message.deleted` socket listener (wherever it lives in `RoomClient.tsx` or equivalent — this spec doesn't name the file since the brief lists only 3 FE files in the "you own" list, and R15 flags this as the one out-of-list edit needing approval via §8 Q3). The reducer:

```ts
// Pseudocode — map over messages in state:
if (msg.replyTo?.id === event.messageId) {
  return { ...msg, replyTo: { ...msg.replyTo, deletedAt: event.deletedAt, text: "" } };
}
```

No server round-trip. Live subscribers see the quoted block flip within the same tick as the tombstone of the parent itself.

### Test strategy

One new backend test file per brief: `apps/backend/tests/message-replies.test.ts`. Structure:

- setup: seed two rooms (alice+bob in room A; alice+carol in room B) via the existing test harness.
- groups: R2/R3/R4 (parent validation), R5 (send shape), R6 (history hydration), R7 (truncation), R8 (DM parity), R9/R10 (edit pass-through + live-drift doc), R11a (server side of parent-delete flip), R16/R17 (idempotency + dedup).
- Each `it(...)` title embeds `REQ-110` or `REQ-133` so `pnpm trace` finds them. Several its share R-IDs (e.g. R3a/R3b/R3c cross-room branches).

Web unit tests (Vitest + @testing-library/react) live alongside components: `MessageActions.test.tsx`, `MessageComposer.test.tsx`, `MessageList.test.tsx` — extend existing files (all exist already, per repo layout). R11b (reducer) is unit-tested in whichever file owns the socket `message.deleted` listener (§8 Q3).

**Dual-browser Playwright smoke** lives in `tests/e2e/replies.spec.ts` (new). Uses two BrowserContexts from different engines per `feedback-playwright-multi-user.md` memory. Scenario matches the brief's gate criteria verbatim — 4 steps (send / reply / edit parent / delete parent). Not a gate item for this spec; recorded for the hackathon's manual-smoke pass.

**`pino` LOG_LEVEL = `"warn"` in tests** per `feedback-pino-log-level` memory; existing `testSetup.ts` already sets this.

**React-hook-form / SPA race guard**: MessageComposer uses `useState`, not react-hook-form, so the memory `feedback-playwright-rhf-spa-transition` doesn't bite here. The Playwright smoke doesn't need the `await page.waitFor(destinationSelector)` workaround beyond normal Playwright auto-wait on the composer textarea.

## 6. Tasks (each <2h, R-numbers map to §4)

1. [ ] **DTO + protocol extension (R1, R5)** — Tighten `sendMessageSchema.replyToId` to UUID; extend `MessagePayload` interface in `protocol.ts` with `replyTo: ReplyToPreview | null` (new exported type). Export `REPLY_PREVIEW_MAX` / `REPLY_PREVIEW_ELLIPSIS` constants. Run `pnpm --filter shared build`. Run `pnpm --filter backend typecheck` — this WILL fail on the existing serializer call-sites; treat failures as task 2's work surface.
2. [ ] **Serializer + preview helper (R4, R5, R7)** — Create `apps/backend/src/lib/reply-preview.ts`. Extend `toMessagePayload` to accept optional `parent` arg. Update the DM listing site (dms.ts `latestByRoom` path — see note in §5) to keep back-compat by passing `null` (not loading parents for the `lastMessage` path in this task — deferred to task 8). Add `// TODO(hackathon): DM lastMessage.replyTo hydrated in task 8 — currently null even for reply-last-messages` at the dms.ts call-site so the gap is visible at merge. Typecheck green.
3. [ ] **Send-path parent validation (R2, R3, R16, R17)** — `apps/backend/tests/message-replies.test.ts` — seed + tests for: parent not found → 400 reply_parent_not_found; parent in different room → 400 reply_cross_room; parent in DM not caller's → 400 reply_cross_room; parent in same room → 201; deleted parent allowed → 201 with replyTo.deletedAt non-null; idempotency with replyToId. Implement the SELECT in the send handler (ahead of the existing `normalizeBody` call). Tests green.
4. [ ] **Send-path broadcast shape (R5)** — Extend the test to subscribe a second socket client, assert `message.new` event payload includes `replyTo` with correct shape; assert `replyTo === null` on non-reply send. Server change is just plumbing the parent fetch result through `toMessagePayload`.
5. [ ] **History LEFT JOIN hydration (R6)** — Extend `GET /rooms/:id/messages` query to `leftJoin(parent)`. Seed 5 messages incl 3 replies; GET; assert hydration. Keep query count at 1 JOIN (not N+1). Tests green.
6. [ ] **Truncation (R7)** — Unit test `previewFromParent` with 500-char body → 121-char output ending in `…`; 50-char body → verbatim. 1 test file for the helper; already exercised by R5/R6 tests too.
7. [ ] **DM parity (R8)** — extend tests: alice+bob DM, bob replies, assert replyTo; `GET /api/v1/dms` returns lastMessage.replyTo populated (requires a second-pass update in dms.ts to JOIN parent for lastMessage — tracked separately in task 8).
8. [ ] **DM listing lastMessage replyTo (R8 completion)** — update [dms.ts:312-321](../../apps/backend/src/routes/dms.ts#L312-L321) `latestByRoom` fetch to also fetch parent rows for those lastMessages that have `reply_to_id`. Batched via `inArray` — ONE extra SELECT per listing call, not N+1. Asserted in task 7's dms-list test extension.
9. [ ] **Edit/Delete pass-through (R9)** — small test: send reply → PATCH body → response MessagePayload includes replyTo; DELETE reply → 204 (no shape concern, message.deleted event unchanged). No handler code changes except the serializer call in edit's response path gets the (optional) parent row fed in OR passes undefined; the undefined path is back-compat and test-confirmed.
10. [ ] **Frontend — `MessageActions` Reply button (R13)** — add `onReply?` prop + render button + test. Small. ~30min.
11. [ ] **Frontend — `MessageComposer` reply chip (R12)** — add `replyTo?` + `onClearReply?` props + chip render + `onSend` signature change. Update the one existing call-site in the `onSend` chain. Tests: chip render, × click, Enter-submit passes `replyToId`. ~1h.
12. [ ] **Frontend — `MessageList` quoted-block render (R14)** — add quoted-block subtree above body when `message.replyTo !== null`; handle `[deleted]` branch; tests. ~45min.
13. [ ] **Frontend — `RoomClient` wiring + parent-delete reducer (R11 client, R15)** — add `replyTo` state + `onReply` handler that sets it + `onClearReply` that clears it; extend the `message.deleted` socket listener's state mutation to flip matching replies' `replyTo`. Depends on §8 Q3 approval. ~1h.
14. [ ] **Dual-browser Playwright smoke** — `tests/e2e/replies.spec.ts` using Chrome + Firefox contexts per `feedback-playwright-multi-user` memory. 4-step scenario from brief gate criteria. Not a hard gate for merge, but record the output for the manual-smoke slot.
15. [ ] **Gate: `pnpm --filter backend test:run` + `pnpm --filter web test:run` + `pnpm typecheck` + `pnpm trace` green** — before declaring done.

## 7. Out of scope / follow-ups

- **True send-time snapshot for `replyTo.text`** — requires a migration (`message.reply_to_body_snapshot text` + `message.reply_to_author_username_snapshot text`). §8 Q1 discusses. The brief says "You add no migrations"; if the snapshot is non-negotiable, the right move is a wave2 migration with a backfill that sets snapshot = parent body at migration time (or NULL for historical replies, which falls back to live hydration). Flagged for post-demo polish if judges notice the edit-drift on refresh.
- **Click-quote-to-scroll-to-parent** — brief kill-switch #1 cuts this from MVP. Follow-up: `MessageList` adds an `onClickQuote: (parentId) => void` prop that uses Virtuoso's `scrollToIndex` to jump if the parent is in the loaded window; no-op otherwise. No backend work needed. ~30min task.
- **Notification on "you were replied to"** — v4 REQ-110 stops at the preview; S3 hardening spec may add a per-user "replied-to" badge. Out of wave1.
- **Reply attachments parity** — works today because attachments flow through the same send path; tests for the combined case (reply + attachment) are a candidate S2 test polish item, not a spec requirement.
- **Reply in GDPR export** — `UserDataExport.messages` in [protocol.ts:328-336](../../apps/backend/src/protocol.ts#L328-L336) is a minimal shape that doesn't currently carry `replyToId`. If "portability" means export-must-include-reply-context, the REQ-126 spec owner adds `replyToId` to the export message shape. Contract item; not owned here.
- **Admin moderation of replies (REQ-065 report abuse)** — per `s2-dms.md` §2 same scope rule: out.
- **Kill-switch #2 (cut DM replies)** — deliberately not taken. R8 is cheap (shared serializer). Only cut if implementation runs past H+2 on the DM lastMessage JOIN.
- **Kill-switch #3 (client-side-only truncation)** — taken only if R7 tests trip up on edge cases (combining diacritics, emoji clusters, etc.). Record the cut in `FOLLOWUPS.md` if triggered; the client renderer in MessageList uses CSS `line-clamp-1` which is a visual-only truncation and doesn't need the server-side `slice`. Tradeoff: full body goes over the wire for every reply; at 120B avg this is noise, but long-parent spam would cost. Acceptable for MVP.

## 8. Open questions

Gating groups:

- **Blocks tasks 1 + 2 (DTO + protocol)**: Q1 (snapshot vs live), Q4 (constants home).
- **Blocks task 3 (error codes)**: Q2 (distinct vs collapsed 400 codes).
- **Blocks task 13 (RoomClient edit)**: Q3 (scope — one file outside the brief's "you own" list).

- [x] **Q1 — `replyTo.text` snapshot vs live. RESOLVED: LIVE.** Brief §2 says "send-time snapshot so later edits of the parent don't silently mutate the quoted preview" AND "You add no migrations" — these are **in tension**; a true snapshot needs a persisted column, and without one hydration reads `parent.body` live, so a parent edit on page refresh drifts the preview. **v3.docx §2.5.3 is silent** on snapshot vs live: its full text is just "A user may reply to another message. The replied-to message shall be visually outlined or quoted in the message UI." Since v3.docx (binding) does not mandate snapshot, the "no migrations" constraint wins and the LIVE path is compliant. Options were:
    - **(a) LIVE** (approved) — no migration; `replyTo.text` reads `parent.body` on history hydration. Live subscribers hold their in-memory payload and do not refresh on parent edit → the brief's smoke scenario ("Bob's existing quoted block still reads 'hello team'") passes in-session. Parent-refresh after edit would show the new body — minor visual drift, no correctness loss.
    - **(b) SNAPSHOT** — add `message.reply_to_body_snapshot text` + `message.reply_to_author_username_snapshot text` via a new migration. Deferred to post-hackathon if observed drift is complained-about.
- [x] **Q2 — error codes. RESOLVED: collapsed single code `reply_parent_invalid`.** Matches `messages.ts:492-494` precedent (`message_not_found` covers both "missing" and "in a different room"). Distinct codes rejected: client doesn't branch on them, and split values leak an (admittedly weak) existence oracle.
- [x] **Q3 — RoomClient.tsx scope. RESOLVED: scoped edit approved.** Confined to (a) the `message.deleted` reducer branch that updates matching `replyTo` fields (R11) and (b) the `replyTo` state + `onReply` / `onClearReply` wiring that clears on send (R15). No layout, no styling, no opportunistic refactor. If task 13 reveals a third required edit, stop and re-ask.
- [x] **Q4 — constants home. RESOLVED: `packages/shared/src/protocol.ts`.** Truncation is server-enforced (R7), so the constant is wire-level, not input-validation. `dto.ts` reserved for FE-only shape.

**Contract gaps spotted (informational, no approval required):**

- `message.reply_to_id` has no DB FK constraint. App-layer validation (R2) is the only guarantee. If a future admin tool hard-deletes a parent, orphan replies become `reply_to_id` pointing at nothing, and R6's LEFT JOIN yields `replyTo: null` — meaning the reply "forgets" its quote context. This is fine for MVP; soft-delete is the only mutation that exists today, so it can't happen.
- `toMessagePayload`'s new optional `parent` arg means call-sites that don't pass it silently render `replyTo: null` even when `reply_to_id IS NOT NULL`. This affects the DM listing's current `latestByRoom` code path until task 8 lands. Tests must cover the ordered landing: task 2's serializer change alone does NOT ship a regression, because pre-task-2 callers pass `undefined` which maps to `replyTo: null` consistently. Task 8 (or a TODO) closes the gap.

## 9. Gate criteria (self-check before declaring done)

- [ ] `pnpm --filter backend test:run` green (all `message-replies.test.ts` its pass; existing suite unaffected)
- [ ] `pnpm --filter web test:run` green (MessageActions + MessageComposer + MessageList test extensions pass)
- [ ] `pnpm typecheck` green in `shared`, `backend`, `web`
- [ ] `pnpm trace` covers REQ-110 + REQ-133 (test names embed the IDs)
- [ ] Manual dual-browser (Chrome + Firefox) smoke:
    - [ ] Alice sends "hello team" → Bob clicks Reply → types "can we make this private?" → Alice sees the message with a quoted block matching Appendix A visual
    - [ ] Alice edits parent to "hello everyone" → Bob's existing quoted block still reads "hello team" (in-memory snapshot preserved; live-drift would only show on hard refresh)
    - [ ] Alice deletes parent → quoted block flips to "[deleted]" within the same tick (socket-driven)
    - [ ] Bob in a different room cannot reply-to a message in Alice's room (cross-room replyToId → 400 reply_parent_invalid, per Q2 resolution)
    - [ ] Works in DMs identically
- [ ] Kill-switch audit: any cuts recorded in `FOLLOWUPS.md` before merge

Timebox: wave1 merge target is H+47 per hackathon schedule. Spec-approval gate → implementation opens; implementation fits in ~6–8h if Q1/Q2/Q3 are answered inline. The brief's kill-switches (#1 scroll-to-parent, #2 DM replies, #3 server-side truncation) are the descent path; none of the 3 hit security or correctness invariants.

## 10. Acceptance test outline (REQ → test mapping)

| REQ-ID | How exercised | Layer |
| --- | --- | --- |
| REQ-110 (parent validation) | R2/R3/R4 — parent-not-found + cross-room + deleted-parent branches in `message-replies.test.ts` | integration |
| REQ-110 (history hydration) | R6 — 1-JOIN history; R11a — server-side parent-delete flip | integration |
| REQ-110 (payload shape) | R5 — send response + `message.new` event payload incl `replyTo` | integration (Socket.IO) |
| REQ-110 (truncation) | R7 — `previewFromParent` unit test | unit |
| REQ-110 (DM parity) | R8 — DM send + DM listing `lastMessage.replyTo` | integration |
| REQ-110 (edit/delete pass-through) | R9 — PATCH response shape; DELETE event unchanged | integration |
| REQ-110 (parent-edit drift) | R10 — documents the live-hydration tradeoff (§8 Q1) | integration |
| REQ-110 (FE quoted block) | R14 — MessageList unit test renders quoted block + `[deleted]` branch | unit (web) |
| REQ-110 (FE parent-delete reducer) | R11b — reducer unit test | unit (web) |
| REQ-133 (Reply action) | R13 — MessageActions renders Reply button | unit (web) |
| REQ-133 (Reply chip composer) | R12 — MessageComposer chip render + clear + replyToId arg | unit (web) |
| REQ-133 (end-to-end) | R15 — Playwright dual-browser smoke | e2e |

**Security-critical invariant (do NOT cut, per brief)**: cross-room parent rejection (R3) is the only security test here. Send-time snapshot + deleted-parent handling are correctness/UX; all three stay in regardless of kill-switch pressure.
