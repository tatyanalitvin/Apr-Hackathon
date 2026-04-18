# Spec: S2 — Rooms (catalog + self-join + auto-enroll)

**Status**: stub (2026-04-18)
**Branch**: `feat/s2-rooms` (worktree to be created off `main` alongside feat/s2-friendship)
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code — S2 rooms agent
**Scope**: REQ-022, REQ-023 — public room catalog + user self-enrollment into group rooms. The auto-enroll-into-`general`-on-signup half of REQ-022 already ships in S1 via a better-auth `databaseHooks.user.create.after` hook ([apps/backend/src/auth.ts]) with a partial test in [apps/backend/tests/register-auto-enroll.test.ts]; this spec completes the REQ.

## 1. Why

Today every new user is auto-enrolled into `general` by a hotfix hook, because `message-auth.ts` would otherwise 403 the first post (REQ-022 is "rooms catalog + self-join" and without it, signup → send-message blows up). The hook solves signup-to-chat in S1, but the rest of REQ-022 — a browsable catalog of public rooms + a "Join" button — is still missing, so a user cannot discover or enter any room beyond `general`. REQ-023 is the catalog endpoint itself (listing public group rooms).

s2-dms.md §5 line 206 already assumes this catalog exists (uses REQ-022 as an implicit filter for DM visibility). Without this spec, that assumption drifts into the implementation.

## 2. Non-goals

- **Room creation UI** — s1-web.md already defers the "Create room" button to S2 via a `TODO(S2)` in `RoomList.tsx`. Creation is adjacent but distinct; it gets its own task inside this spec (§6) or a sibling spec if it grows.
- **Private room invitations** — separate flow; not in REQ-022/REQ-023.
- **DM rooms** — `s2-dms.md`. DMs are `kind='dm'` rooms; this catalog filters to `kind='group' AND visibility='public'`.
- **Room deletion / archival** — out of scope for S2.
- **Nested channels / threading** — out of scope entirely.

## 3. User stories

- As Anna, I `GET /api/v1/rooms` and see the list of public group rooms I can join, so I can browse beyond `#general`. (REQ-023)
- As Anna, I `POST /api/v1/rooms/:id/join` on a public group room I'm not yet a member of, and a `room_member` row is created so I can read and post. (REQ-022 self-join half)
- As Anna, I sign up for the first time and `#general` appears in my rooms list with a welcome message already visible — no explicit join needed. (REQ-022 auto-enroll half — already ships in S1)

## 4. Requirements (testable)

`pnpm trace` greps `tests/` for each REQ-ID. `describe`/`test` names MUST embed them.

- [x] **R1 (REQ-022 auto-enroll)**: On `auth.api.signUpEmail` completion, a `room_member` row exists for `(newUser.id, 'general')`. Shipped in S1; test at [apps/backend/tests/register-auto-enroll.test.ts](../../apps/backend/tests/register-auto-enroll.test.ts).
- [ ] **R2 (REQ-022 self-join)**: `POST /api/v1/rooms/:id/join` — caller is authenticated; target room exists, is `kind='group'`, and is `visibility='public'`. INSERT `room_member (userId=caller, roomId=:id)` ON CONFLICT DO NOTHING (idempotent: 200 either way with `{ joined: boolean }` indicating whether a new row was created). 404 if room doesn't exist; 403 if room is `visibility='private'` (private rooms require invitation; scope-bounded by §2).
- [ ] **R3 (REQ-023 catalog)**: `GET /api/v1/rooms` — returns `{ rooms: Array<{ id, name, kind, visibility, memberCount, isMember }> }` filtered to `kind='group' AND visibility='public'`. `isMember` is true iff the caller has a `room_member` row for that roomId. Ordered by `memberCount DESC, name ASC`. 401 without session.
- [ ] **R4 (REQ-023 per-user rooms)**: `GET /api/v1/rooms/me` — returns `{ rooms: Array<{ id, name, kind, visibility, lastReadSeq, roomHeadSeq }> }` for every room the caller is a `room_member` of (including DMs). Ordered by most-recent-activity. **Wires s1-web.md's hardcoded `general` list** (flagged as `TODO(S2)` in RoomList.tsx) to a real endpoint.

## 5. Design notes

### Data model

No schema changes. All three endpoints read/write existing tables: `room`, `room_member`.

### Endpoint ownership

All three new routes land in `apps/backend/src/routes/rooms.ts` (new file). The existing hook in `auth.ts` that handles auto-enroll stays put — it's orthogonal to this spec's HTTP surface.

### Rate limits

`POST /rooms/:id/join` should carry a rate limit to prevent join-spam (e.g. 60 joins per user per hour). Re-use `@fastify/rate-limit` + Redis (already pinned per CLAUDE.md tech stack).

## 6. Tasks (draft)

1. [ ] `/spec` review + §8 resolution before implementation.
2. [ ] Write failing test for R2 (self-join happy + conflict-idempotent + private-room 403). Implement. Commit.
3. [ ] Write failing test for R3 (catalog filters, `isMember` derivation, ordering). Implement. Commit.
4. [ ] Write failing test for R4 (`/rooms/me` returns caller's memberships only). Implement. Commit.
5. [ ] Web: replace `RoomList.tsx` hardcoded list with `/rooms/me` call; wire `/rooms/browse` page against `/rooms`; add "Create room" button placeholder (still `TODO(S2)` for creation endpoint itself).
6. [ ] Update `docs/FOLLOWUPS.md` to close the two `TODO(S2)` items in s1-web.md.

## 7. Out of scope / follow-ups

- **Room creation endpoint** — can be added as R5 here or split out. Currently excluded from this stub.
- **Room member presence on catalog** — "who's online in this room right now" would be nice but depends on s2-afk-presence landing first.
- **Leave room** (`DELETE /api/v1/rooms/:id/members/me`) — trivial sibling of self-join; add as R6 when this spec leaves stub status.

## 8. Open questions

Must resolve before approval:

- [ ] **Q1**: Should `POST /rooms/:id/join` emit a Socket.IO `room.member.joined` event so other members see a join notification in-room? v3.docx is silent. Recommendation: **yes** — one line of protocol.ts addition (same pattern as s2-friendship Q3), one `server.to(roomId).emit(...)` in the handler. Cheap and makes the demo feel alive. Protocol change needs approval per CLAUDE.md non-neg #5.
- [ ] **Q2**: Should `GET /rooms` include `visibility='private'` rooms that the caller is already a member of? Current R3 filters strictly to public. If private rooms a user has been invited to should surface here, we need to union. Recommendation: **keep R3 public-only; rely on R4 (`/rooms/me`) for "rooms I'm in, regardless of visibility"** — clean separation, matches v3.docx §2.4 intent.
- [ ] **Q3**: Pagination on `GET /rooms`? At hackathon demo scale (~5 rooms) none is needed. Recommendation: **ship without; add `cursor` + `limit` in S3 if the catalog grows**.

## 9. Gate criteria

Self-check before declaring "S2 rooms done":

- [ ] `pnpm --filter backend test:run` green — catalog + self-join tests pass
- [ ] `pnpm trace` reports REQ-022 and REQ-023 as covered (no longer zombies)
- [ ] Manual: fresh signup → `/rooms` shows `#general`; browse page shows other public rooms; click "Join" → row appears; enter room → send message → broadcast works
- [ ] `TODO(S2)` markers in [apps/web/src/components/chat/RoomList.tsx] deleted; replaced with real endpoint calls

## 10. Acceptance test outline (REQ → test mapping)

| REQ-ID | How exercised | Layer |
| --- | --- | --- |
| REQ-022 | auto-enroll on sign-up inserts `room_member` row (R1); self-join POST inserts / is idempotent (R2) | integration |
| REQ-023 | catalog filter (`kind=group`, `visibility=public`), `isMember` derivation, ordering (R3); `/rooms/me` returns caller memberships (R4) | integration |
