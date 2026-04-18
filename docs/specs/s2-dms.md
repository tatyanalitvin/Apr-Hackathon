# Spec: S2 — DMs (2-person rooms with kind='dm')

**Status**: draft (2026-04-18)
**Branch**: `feat/s2-dms` (worktree to be created off `main` after S1 + `feat/s2-friendship` merge)
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code — S2 relationships agent (pairs with `s2-friendship.md`)
**Scope**: REQ-061 … REQ-066 (DM entity, parity with rooms, freeze semantics). Depends on `s2-friendship.md` for the friendship + user_block tables that gate DM creation and send.

## 1. Why

BRIEF.md demo step 4 is "Alice and bob open a DM; alice uploads a photo; bob sees it inline". No DM → no demo differentiation from S1 (which is already one public room). DMs also trigger two of the most judge-visible correctness claims: (a) the same-pipeline message fanout (REQ-062 — DMs use the same `messages` table, same seq allocator, same `message.new` event as rooms) and (b) the freeze semantics (REQ-066 — losing friendship or being blocked must instantly stop sending without removing history).

The key design choice that makes this spec short: **DMs are 2-person rooms with `kind='dm'`, not a separate `dialogs` entity.** v4 REQ-061 describes a `dialogs` table; our schema ([packages/shared/src/schema.ts:26](../../packages/shared/src/schema.ts#L26)) already has `roomKind = pgEnum("room_kind", ["group", "dm"])` and `room.name` is nullable specifically to let DM rooms derive names from participants. The task brief is explicit: "reuse existing message + seq + broadcast pipeline — do not design a separate DM path". This spec codifies that choice and flags the resulting v4 deviations in §8.

## 2. Non-goals

Explicit, so reviewers don't flag:

- **Friendship / user-block tables + endpoints** — `s2-friendship.md` owns them (REQ-050..REQ-060, REQ-073, REQ-074). This spec READS those tables but never writes them.
- **Report-abuse flow (REQ-065)** — moderation track. This spec does NOT ship the `reports` table or the "Report" button backend.
- **Admin platform tooling (REQ-156 / REQ-157)** — out of S2 per BRIEF.md.
- **Attachments on DMs (REQ-063's attachment clause)** — attachments land in a separate S2 spec (`s2-attachments.md`, REQ-075..REQ-085). DM parity with attachments is a follow-up; this spec ships text-only DM MVP and flags the parity gap in §7.
- **Edit / delete message (REQ-063's edit + delete clause)** — S2 `s2-edit-delete.md` (REQ-110..REQ-114). This spec's DM send reuses the existing message row; any future `edit`/`delete` endpoint in that spec MUST honor the same freeze check defined here, which is a contract item documented in §7.
- **Typing indicator** — S2 soft scope per BRIEF.md; not owned here.
- **DM member list UI** — REQ-063 says DMs have "only the two participants"; there is no "add member" endpoint. This is a non-goal, not a feature.
- **Multi-party DMs / group DMs** — REQ-061 is strictly pairwise (`user_low, user_high`). Our `roomMember` table has no 2-cap on `kind='dm'`; enforcing cap=2 is R3 below, not a non-goal, but any "add a third person" path is explicitly out.
- **Separate DM history endpoint** — REQ-062 mandates parity; DM history is just `GET /api/v1/rooms/:id/messages` (the S1-landed handler) with membership check handling DM the same as any other room.

## 3. User stories

- As Alice, once bob and I are friends (prerequisite from `s2-friendship.md`), I can `POST /api/v1/dms` with `{ userId: bob.id }` and the server returns a room with `kind='dm'`. If the DM already exists, the same room is returned — no duplicate is created. (REQ-061, find-or-create)
- As Alice, `POST /api/v1/dms` targeting someone I'm not friends with returns `403 { error: "dm_not_allowed" }`. (REQ-060 gate)
- As Alice, `POST /api/v1/dms` targeting someone who has blocked me — or whom I have blocked — also returns `403 { error: "dm_not_allowed" }`. (REQ-073 effect 4 — cannot initiate)
- As Alice, sending a message in the DM uses the exact same `POST /api/v1/rooms/:id/messages` endpoint as a group room; I see `message.new` with `{seq, roomHeadSeq}` in bob's browser. (REQ-062, REQ-063)
- As Alice, when I unfriend bob (`DELETE /api/v1/friends/:userId`), the DM is NOT deleted — history stays — but any subsequent send from either side returns `409 { error: "dialog_frozen" }`. (REQ-066)
- As Alice, when bob blocks me (`POST /api/v1/users/:id/block` from bob), the existing DM also becomes frozen for both sides. History remains readable. (REQ-066 + REQ-073 effect 2)
- As Alice, if the block is removed AND we re-friend, the DM unfreezes automatically on the next send — no unfreeze endpoint. (REQ-066 auto-unfreeze)
- As Alice, `GET /api/v1/dms` returns my DM rooms (room rows with kind='dm' where I am a member). (listing, derived from REQ-062 parity)
- As Alice, I cannot invite a third user to the DM room — there is no admin / invite endpoint exposed for `kind='dm'` rooms. (REQ-063)

## 4. Requirements (testable)

`pnpm trace` greps `tests/` for each REQ-ID; test names MUST embed them verbatim.

- [ ] **R1 (REQ-061 find-or-create)**: `POST /api/v1/dms` with `{ userId: targetId }` — if a `room` with `kind='dm'` already exists whose `roomMember` rows are exactly `{callerId, targetId}`, return 200 with that room. Else create: new `room` row with `kind='dm'`, `visibility='private'`, `name=NULL`, `ownerId=NULL` (REQ-064: no DM admins); two `roomMember` rows (roles `'member'`); one `messageSeq` row for the new roomId (mandatory since S1's allocator reads it). All in a single transaction. Return 201 with the room payload. Self-DM (`callerId === targetId`) → 400.
- [ ] **R2 (REQ-061 pair canonicalization)**: The find-half of R1 MUST be deterministic and O(1). Implementation: canonicalize the pair by sorting user ids, store in a new column `room.dmPairKey = \`${low}:${high}\`` with a partial unique index `WHERE kind = 'dm'`. The find query is `SELECT … WHERE kind='dm' AND dm_pair_key = $1`. **Data model gap flagged**: `room` currently has no `dmPairKey` column. Alternatives in §8 Q1. R1's transaction depends on whichever approach is approved.
- [ ] **R3 (REQ-063 2-member cap)**: A DM room MUST always have exactly 2 members. Enforce via: (a) the only insert path for `roomMember` on `kind='dm'` rooms is R1, which inserts exactly two; (b) no `/rooms/:id/members` endpoint accepts `kind='dm'` rooms (S2 room-management spec enforces this — contract item). This spec's test: attempt to insert a third `roomMember` via raw SQL / a future unsafe endpoint, assert the business-logic check rejects it. **No DB-level CHECK** — that would be cross-table (count of `roomMember` per `roomId`) and expensive; the check lives in application code.
- [ ] **R4 (REQ-060 precondition at create)**: R1's transaction reads `friendship` and `user_block` before the insert. If `friendship` row does not exist for the pair OR a `user_block` row exists in either direction, return `403 { error: "dm_not_allowed" }` with NO room created. Test: four branches — (a) not friends → 403, (b) friends + caller blocked target → 403, (c) friends + target blocked caller → 403, (d) friends + no blocks → 201. REQ-060 explicit: "Attempting to send otherwise returns `403` with code `dm_not_allowed`."
- [ ] **R5 (REQ-066 frozen-send predicate)**: When a message is sent to a room with `kind='dm'`, the send handler MUST check the freeze predicate BEFORE allocating seq:
    ```
    is_frozen(dm_room) = NOT exists(friendship where {memberA, memberB})
                         OR exists(user_block where (by=A,target=B) or (by=B,target=A))
    ```
    If frozen, return `409 { error: "dialog_frozen" }` with NO seq consumed and NO broadcast. Implementation: extend the S1-landed `requireRoomMember` helper (or add `requireSendableRoom`) to also load `room.kind`; if `kind='dm'`, run the predicate. Group-room sends skip the predicate (fast path). Tests: two scenarios — (a) remove friendship → frozen; (b) create user_block either direction → frozen.
- [ ] **R6 (REQ-066 read-after-freeze)**: `GET /api/v1/rooms/:id/messages` on a frozen DM MUST still return full history for both members. Freeze affects writes only. Test: freeze a DM with 10 messages; both members can still GET all 10. No change to the S1-landed history handler — it already only checks membership.
- [ ] **R7 (REQ-066 auto-unfreeze)**: No explicit unfreeze endpoint. The freeze predicate (R5) is evaluated per send. If the underlying rows flip (re-friend via `s2-friendship.md` R8 + no block), the next send succeeds. Test: freeze → re-friend → send → 201.
- [ ] **R8 (REQ-062 same pipeline)**: `POST /api/v1/rooms/:id/messages` on a DM room uses the SAME handler as group rooms. `message.new` event emitted carries the same `{seq, roomHeadSeq, message}` shape (see [packages/shared/src/protocol.ts:29-35](../../packages/shared/src/protocol.ts#L29-L35)). No new Socket.IO event for DMs. Test: alice sends in DM; bob's subscribed socket receives `message.new` within the same tick with `evt.seq === evt.roomHeadSeq === evt.message.seq` — identical to the S1 REQ-034 assertion.
- [ ] **R9 (REQ-062 seq parity)**: Each DM room has its own `message_seq.seq` counter, allocated per-room exactly like a group room. 100 parallel sends in one DM → 100 unique contiguous seqs. Test reuses the S1 allocator rig, just targeting a DM roomId.
- [ ] **R10 (REQ-063 no admin actions)**: DM rooms have `ownerId=NULL`. Any future endpoint that checks `room.ownerId` or `room_member.role='owner'|'admin'` MUST early-return on `kind='dm'`. This spec's test: assert `ownerId IS NULL` for rooms created via R1, and assert no `roomMember` row has `role != 'member'` for those rooms.
- [ ] **R11 (listing)**: `GET /api/v1/dms` returns `{ dms: Array<{ roomId, other: { userId, username, name }, lastMessage?: MessagePayload, unreadCount: number, frozen: boolean, frozenReason?: "not_friends" | "blocked" }> }` for the authenticated caller. Query: `room` JOIN `roomMember` WHERE caller is a member AND kind='dm', LEFT JOIN the counterpart member + user row, LEFT JOIN latest message. `frozen` / `frozenReason` computed in application code (same predicate as R5). Ordered by latest message `createdAt` DESC (DMs with no messages at the end). `unreadCount` derivation is out of scope here — see §7 (depends on S2 unread spec); ship `unreadCount: 0` placeholder until that spec lands, flag it loudly.
- [ ] **R12 (transverse)**: DM endpoints reuse the same better-auth session helper (`toFetchHeaders` + `getSession`). Missing session → 401. One test per new endpoint (R1, R11).
- [ ] **R13 (no separate DM history)**: No `GET /api/v1/dms/:id/messages` endpoint. DM history is served by `GET /api/v1/rooms/:id/messages`. Test: attempting to GET the hypothetical path returns 404 (route not registered). This is a negative test documenting the design choice; kept minimal.
- [ ] **R14 (room-ban table not applicable)**: `roomBan` (§2.4.8 / REQ-090) does NOT apply to DM rooms. If a DM roomId is passed to any future `/rooms/:id/ban` endpoint, that endpoint MUST reject with 400. This spec's test: assert the S2 room-management spec's handler early-returns on `kind='dm'` (contract item, not enforced here because the handler doesn't exist yet). Keep as a documentation bullet if the test requires a not-yet-landed endpoint.

## 5. Design notes

### Data model

**One schema delta proposed, flagged for approval** (§8 Q1):

- `room.dmPairKey text` column + partial unique index `WHERE kind='dm'`. Populated on R1 insert as `\`${min(caller,target)}:${max(caller,target)}\``. Null for group rooms (the partial unique index excludes them).

If Q1 approves alternative (b) — no column, find-or-create via a subquery on `roomMember` — the tradeoff is:
- **(a) dmPairKey column + partial unique index**: O(1) find, idempotency enforced at the DB level (unique-violation → select-and-return). Schema change.
- **(b) subquery**: `SELECT r.id FROM room r WHERE r.kind='dm' AND NOT EXISTS (SELECT 1 FROM room_member rm WHERE rm.room_id=r.id AND rm.user_id NOT IN ($caller,$target)) AND EXISTS (SELECT 1 FROM room_member WHERE room_id=r.id AND user_id=$caller) AND EXISTS (SELECT 1 FROM room_member WHERE room_id=r.id AND user_id=$target)`. Correct but O(n) over DM count per user; race with concurrent creates needs an advisory lock on `hashtext("dm:" || low || ":" || high)` to prevent two rooms being created for the same pair. More code, no schema change.

Recommendation: (a). The `dmPairKey` column is 40 bytes per DM row, the partial unique index is tiny (rooms aren't high-cardinality), and O(1) find matters for the listing endpoint too.

**No other schema changes.** Existing tables cover the rest:

- `room` — already has `kind='dm'`, nullable `name`, nullable `ownerId`. R1's "ownerId=NULL on DM" is just using the existing NULL allowance.
- `roomMember` — used as-is; two rows per DM.
- `messageSeq` — one row per DM roomId, same as group rooms.
- `message` — used as-is. REQ-062's v4 text says "`messages` gets nullable `room_id` and nullable `dialog_id`; exactly one MUST be non-null (CHECK constraint)". Our design does NOT do this — see §8 Q2 for the deviation.
- `friendship`, `user_block` — READ-ONLY from this spec; written by `s2-friendship.md`.

### REST surface

Two new routes in `apps/backend/src/routes/dms.ts`, registered under `/api/v1/dms` in `app.ts` alongside `messagesRoutes` (which already serves both group and DM rooms after this spec lands).

| Route | REQ | Purpose | Body / query | Response |
| --- | --- | --- | --- | --- |
| `POST /api/v1/dms` | REQ-060, REQ-061 | Find-or-create DM with target | `{ userId: string }` (DTO flagged in §8 Q3) | 200 existing room \| 201 created room \| 400 self \| 403 dm_not_allowed |
| `GET /api/v1/dms` | R11 | List caller's DMs | — | `{ dms: [...] }` |

**Messages on DMs reuse S1 routes** — no new endpoints. The only change to S1-landed code is an extension of the send-path membership check to include the freeze predicate (R5).

### Socket.IO surface

**No new events.** DMs reuse `message.new`, `message.edited` (S2 edit), `message.deleted` (S2 delete) exactly as rooms do. The Socket.IO room is just `roomId` — subscribers to a DM's roomId receive broadcasts the same way. The S1-landed `room.subscribe` handler works for DM roomIds without change, modulo the membership check (already present).

**Typing indicator on DMs**: same as rooms — emits `typing` event (exists in `protocol.ts` but unhandled in S1). Not owned here; soft scope in the S2 typing spec if time allows.

### Freeze predicate — placement and cost

Placement: `apps/backend/src/lib/dm-freeze.ts`, a pure-DB-call helper that takes `{ roomId, callerId }` and returns `{ frozen: boolean, reason?: 'not_friends' | 'blocked' }`. Called from:

1. `POST /api/v1/rooms/:id/messages` send handler — one of the first checks after `requireRoomMember`. Only invoked when `room.kind='dm'` (the membership helper already loaded the room record).
2. `GET /api/v1/dms` listing handler — to populate `frozen` / `frozenReason` per DM.

Cost per DM-send: one additional query (two `EXISTS` checks joined via `SELECT EXISTS(..) AS friends, EXISTS(..) AS blocked_either_way`). Acceptable at S2 scale. If the tail latency on DM send becomes problematic at S3 load testing, cache the predicate output per (userA, userB) with a short Redis TTL and invalidate on friendship/block mutations — NOT needed for S2.

### Find-or-create transaction (R1 with approach (a))

```sql
BEGIN;
-- canonicalize
SELECT :caller < :target AS caller_is_low;
-- find
SELECT id FROM room WHERE kind='dm' AND dm_pair_key = :low_high_key;
-- if found, return it; else:
INSERT INTO room (id, kind, visibility, dm_pair_key) VALUES (...)
  ON CONFLICT (dm_pair_key) WHERE kind='dm' DO NOTHING RETURNING id;
-- if ON CONFLICT returned no row, re-SELECT (lost the race)
INSERT INTO room_member (...) VALUES (:caller), (:target);
INSERT INTO message_seq (room_id, seq) VALUES (:new_room_id, 0);
COMMIT;
```

Drizzle expression: `db.transaction(async (tx) => { ... })`; the ON CONFLICT path handles the concurrent-create race without an explicit advisory lock.

### Auth + membership reuse

R1 reads `user.id` for `userId` path param (target). Validate that the target user exists (`SELECT 1 FROM user WHERE id = :target`) — if not, 404 (this IS an enumeration-friendly 404; see §8 Q4 for whether to mask as 403 `dm_not_allowed` instead). R5 reuses the S1-landed `requireRoomMember` helper exactly; freeze check is layered on top when `room.kind='dm'`.

### DTO / protocol additions

- `packages/shared/src/dto.ts` — add `createDmSchema = z.object({ userId: z.string().min(1) })`. Also add the `DmListItem` response type (or keep as an interface in `protocol.ts` since it's a wire shape). §8 Q3.
- `packages/shared/src/protocol.ts` — NO changes needed for MVP DM (no new events). §8 Q3 only affects dto.

## 6. Tasks (each <2h, R-numbers map to §4)

1. [ ] **Route scaffold + dto** — `apps/backend/src/routes/dms.ts`, register under `/api/v1`. Add `createDmSchema` to `dto.ts`. Smoke: 401 without cookie (R12). BLOCKED on §8 Q3 if dto change needs approval; the zod literal `z.object({ userId: z.string() })` is minimal — should clear approval quickly.
2. [ ] **Schema delta: `dmPairKey` column + partial unique index (R2)** — BLOCKED on §8 Q1. If (a) approved: drizzle-kit generate migration; apply locally; update `schema.ts` with `dmPairKey: text("dm_pair_key")` + partial unique index in the table's index callback (`uniqueIndex("room_dm_pair_uq").on(t.dmPairKey).where(sql\`${t.kind} = 'dm'\`)`). If (b) approved: add the advisory-lock path + write the `lockKey` helper.
3. [ ] **Find-or-create (R1, R4 / REQ-060, REQ-061) — happy path** — `dms-create.test.ts`. Fixtures: alice + bob friends; POST → 201 + room row + 2 members + messageSeq row. Re-POST (find) → 200 + same roomId.
4. [ ] **DM create — gate branches (R4 / REQ-060, REQ-073 effect 4)** — same test file. Four branches: not friends → 403, caller-blocks-target → 403, target-blocks-caller → 403, self-DM → 400. Assert NO room created in each failure case.
5. [ ] **Concurrent create race (R1 tail)** — `dms-create-race.test.ts`. Fire 20 parallel `POST /api/v1/dms` with the same `{ userId }` from alice; assert exactly one room created, all 20 responses return the same roomId (some 201, rest 200).
6. [ ] **2-member cap assertion (R3)** — `dms-membership.test.ts`. Assert the DM room has exactly 2 `roomMember` rows; assert `ownerId IS NULL`; assert both rows have `role='member'`.
7. [ ] **Freeze predicate unit tests (R5 helper)** — `dm-freeze.test.ts` (unit). Four branches of the predicate: friends + no block → not frozen; not friends → frozen (not_friends); friends + caller blocked target → frozen (blocked); friends + target blocked caller → frozen (blocked).
8. [ ] **Freeze on send (R5 / REQ-066)** — `dms-send-frozen.test.ts`. Integration. Setup: DM exists, 3 messages sent successfully. Mutate state via friendship/user_block tables (direct DB writes; the friendship spec's endpoints are not a dependency for this test). Assert next send returns 409 dialog_frozen with no new message, no seq advance, no Socket event emitted.
9. [ ] **Read after freeze (R6)** — same file. Frozen DM; GET /rooms/:id/messages still returns all history for both members.
10. [ ] **Auto-unfreeze (R7)** — `dms-send-unfreeze.test.ts`. Start frozen; re-friend and ensure no block; next send returns 201. One test, three phases (frozen → restore → unfrozen).
11. [ ] **Send parity with group rooms (R8 / REQ-062)** — `dms-send-parity.test.ts`. Send in DM; second socket client (bob) subscribed to the DM roomId receives `message.new` with identical event shape to a group-room send. Reuse the REQ-034 assertion harness.
12. [ ] **Seq parity (R9 / REQ-062)** — `dms-seq-concurrency.test.ts`. 100 parallel sends in one DM, assert 100 unique contiguous seqs. Reuse S1's seq allocator rig.
13. [ ] **Listing (R11)** — `dms-list.test.ts`. Two DMs (alice-bob, alice-carol). GET returns both; each carries the counterpart's username. One DM frozen → `frozen: true` + correct `frozenReason`. Ordering: by latest message `createdAt` DESC. `unreadCount: 0` placeholder asserted with a comment pointing to the S2 unread spec.
14. [ ] **Negative: no separate DM history endpoint (R13)** — `dms-route-surface.test.ts`. Hit `GET /api/v1/dms/:id/messages`; expect 404. Documents the design.
15. [ ] **Gate dry-run** — Manual: alice + bob friends; alice POSTs /api/v1/dms → room created; both browsers subscribe; alice sends → bob receives in <1s; alice unfriends bob → alice send returns 409 dialog_frozen; alice re-friends bob → send succeeds; alice blocks bob → send returns 409; unblock → send succeeds.

## 7. Out of scope / follow-ups

- **DM attachments (REQ-063 attachments clause)** — S2 `s2-attachments.md` will wire the attachment upload flow on `message.attachmentIds` (field already accepted by S1 `sendMessageSchema`, ignored in S1 handler). When that spec lands, DM send already flows through the same handler, so parity is free IFF the attachment spec writes the attachment linkage inside the same transaction that R5's freeze check gates. Contract item: attachment endpoint MUST check freeze before accepting the file, or at least before linking to the DM message. Cite this spec.
- **DM edit / delete (REQ-063, REQ-064)** — S2 `s2-edit-delete.md`. REQ-064 requires "only the author may delete"; existing `message.authorId` + the S2 spec's role check enforces it. That spec MUST also honor the freeze predicate defined here (R5). Contract item.
- **Report abuse on DM messages (REQ-065)** — moderation track. Not in S2 per BRIEF.md.
- **`unreadCount` in `GET /api/v1/dms`** — depends on S2 `s2-unread.md` (REQ-120..REQ-124). R11 ships `unreadCount: 0` as a placeholder with an explicit TODO.
- **Dialog's `frozen_at` timestamp column** — v4 REQ-061 defines `dialogs(..., frozen_at NULL)`. Our design computes freeze from `friendship` + `user_block` rows at read time, so no frozen_at is stored. Tradeoff: no audit trail of when the DM froze. Acceptable for S2; S3 moderation may want the timestamp — revisit with `room.dmFrozenAt` column then.
- **REQ-066 auto-unfreeze notification** — the predicate simply starts returning `frozen=false`. There is no "you are unfrozen now" socket event. If the UX wants one, it's a new event; flag for `s2-web.md`.
- **DM creation by username (not just userId)** — R1 takes `userId`. REQ-052's "add friend from member panel" uses userId; there's no REQ-level requirement for "DM by username". Out unless the UI asks.
- **Multi-device fanout for DMs** — same Socket.IO mechanics as rooms. If the S2 presence spec adds per-user-all-devices fanout, DMs benefit for free.

## 8. Open questions

Must resolve before task 2 / task 3:

- [ ] **Q1 — DM find-or-create storage strategy (R2).** Options:
    - **(a)** Add `room.dmPairKey text` column + partial unique index `WHERE kind='dm'`. Schema change; O(1) find; idempotency at DB level.
    - **(b)** No column; find via subquery on `roomMember` + advisory lock on `hashtext("dm:" || low || ":" || high)` to serialize concurrent creates. No schema change; O(n) find (n = DMs per user).
    - **Recommendation**: (a). Schema delta is small (one column + one partial index) and matches the v4 spirit of REQ-061 (lower uuid first canonicalization). Requires human approval (schema change — CLAUDE.md #5). If denied, fall back to (b) with a clearly-commented advisory-lock call.
- [ ] **Q2 — Deviation from v4 REQ-061/REQ-062.** v4 describes a separate `dialogs` table and a `messages` column `dialog_id` with a CHECK constraint enforcing exactly one of `room_id`/`dialog_id` non-null. Our design uses `room.kind='dm'` + the existing `message.roomId`. The task brief explicitly calls for this reuse. **Decision**: document the deviation in an ADR (`docs/adr/0004-dm-as-room.md` — new). The ADR captures: (i) single message pipeline, (ii) no new message column, (iii) freeze computed from friendship/user_block. Requires human approval to author the ADR.
- [ ] **Q3 — DTO / protocol.ts additions.** Adding `createDmSchema` to `dto.ts`. `protocol.ts` unchanged (no new events). Approval needed (dto change — CLAUDE.md #5). Minimal content: `z.object({ userId: z.string().min(1) })`. Also define the `DmListItem` return shape — either as a zod schema or TS interface in `protocol.ts`; recommend zod-in-dto for symmetry with other response shapes, but either is fine.
- [ ] **Q4 — Enumeration defense on REQ-060 / unknown user.** If the target userId doesn't exist, `POST /api/v1/dms` can return (a) 404 (reveals "user not found") or (b) 403 `dm_not_allowed` (symmetric with blocked-by-target). REQ-060 is silent; REQ-053 (friend request under block) explicitly uses sentinel-success to avoid enumeration. Options:
    - **(a)** 404 on unknown — simple, minor enumeration via userId format (userIds are better-auth-generated, not guessable by default). Acceptable.
    - **(b)** 403 `dm_not_allowed` — symmetric, small privacy win.
    - **Recommendation**: (a). The blocked-vs-unknown distinction at DM-create time is not as exploitable as REQ-053's because userIds aren't enumerated by username. If the S3 security pass disagrees, flip to (b) — one-line change.
- [ ] **Q5 — REQ-065 "Report" on DM messages.** Out of S2 scope per BRIEF.md. Confirming the scope decision before anyone assumes DMs ship a report button in the demo. No code impact either way; just a scope confirmation.

**Contract gaps spotted (informational):**

- `roomKind` enum does NOT have a CHECK preventing `name` from being non-null on `kind='dm'`. DM rooms MUST have `name IS NULL` (the comment on `room.name` says so). Enforce in R1 (insert NULL) and in any future room-rename endpoint (reject on `kind='dm'`). Not a spec-blocker.
- `roomVisibility` is set to `'private'` on DM create. No REQ demands this; defended by the "DMs aren't listed in the public room catalog" invariant. The S2 room-catalog endpoint MUST filter `kind='group' AND visibility='public'` — already implicit in REQ-022.

## 9. Gate criteria

Self-check before declaring "S2 DMs done":

- [ ] `pnpm --filter backend test:run` green — all DM tests pass
- [ ] `pnpm trace` covers REQ-060, REQ-061, REQ-062, REQ-063, REQ-064, REQ-066 (REQ-065 explicitly out-of-scope)
- [ ] Manual: alice + bob friends; alice POSTs /api/v1/dms → room created; both subscribe; message delivered <1s
- [ ] Unfriend → next send 409 dialog_frozen; both sides still see history
- [ ] Block (either direction) → send 409; unblock + re-friend → send succeeds
- [ ] Concurrent creates produce one room (idempotency test green)
- [ ] 100 parallel DM sends → 100 unique contiguous seqs
- [ ] No `GET /api/v1/dms/:id/messages` route exists — DM history served by `/rooms/:id/messages`

Timebox: S2 soft gate at H+16 (2026-04-18 24:00 UTC). DM is the second half of the demo "wow" (after friendship). If freeze + unfreeze semantics are incomplete at H+16, ship DM create + send + read and flag freeze as S3 — the demo can still show DM messaging; freeze correctness is a quality win but not a demo-breaker.

## 10. Acceptance test outline (REQ → test mapping)

| REQ-ID | How exercised | Layer |
| --- | --- | --- |
| REQ-060 | POST /dms without friendship → 403 dm_not_allowed | integration |
| REQ-061 | find-or-create: first call creates, second returns same room; concurrent creates idempotent | integration |
| REQ-062 | DM send emits `message.new` with same shape as group-room send; seq allocator parity (100 parallel → unique contiguous) | integration (Socket.IO + concurrency) |
| REQ-063 | DM has exactly 2 members; ownerId NULL; text send works; attachment/edit/delete parity deferred to their specs | integration (partial; full parity cross-spec) |
| REQ-064 | DM rooms have no owner/admin rows (all members role='member', ownerId NULL) | integration |
| REQ-065 | OUT OF SCOPE — confirmed in §2, §8 Q5 | — |
| REQ-066 | unfriend → send 409 dialog_frozen; block either way → 409; re-friend + unblock → send 201; read access preserved throughout | integration (multi-phase) |
