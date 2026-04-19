# Spec: S2 — Room moderation (roles + kick + ban)

**Status**: draft (2026-04-19) — awaiting human approval before any code lands.
**Branch**: `feat/room-roles` (worktree at `../hackaton-room-roles`, off `main@c84948c`).
**Owner (human)**: Tatianka
**Owner (agent)**: Agent A (Claude Code Opus 4.7)
**Binding source**: `/Users/littlewin/Work/2026-Apr-Hackaton/task/2026_04_18_AI_herders_jam_-_requirements_v3.docx` §2.4.7 (owner/admin roles) + §2.4.8 (room ban rules) + §4.5 Manage Room modal (Appendix A wireframe). The v4 REQ catalog (`/task/Chat_Server_Requirements_v4.md` §5.5/§5.6 REQ-090..REQ-095) mirrors these rules and is cross-referenced in §10 for the role matrix — v4 IS NOT binding (the brief is explicit: `/task/*.md` files are AI-generated prep, REQ-ID hooks only).
**Tracking IDs (invented, per brief)**: REQ-200..REQ-211. Claimed in §4, traced by `pnpm trace` after merge.
**Sibling agents**: Agent B owns invitations (`feat/invitations`, migration 0008, `InvitationsTab.tsx`, `room.invitation.*` events). No overlap.

## 1. Why

Today the `room_role` enum + `room_member.role` column + `room_ban` table already exist in the schema (migration `0000_chilly_whirlwind.sql`), and the `rooms.ts` create-room handler writes `role='owner'` for the creator. What's missing is the *operative* surface: no promote/demote, no kick, no ban, no unban, no ban-list view. The Manage Room modal ships on main with Members/Admins/Banned tabs as stubs (`coming soon` placeholder text). Without this feature, room owners cannot moderate — a hackathon demo of "admin tooling" falls flat.

The v3.docx §2.4.7/§2.4.8 text is the contract. v4 §5.6 REQ-092's role matrix codifies what Member vs Admin vs Owner can do — this spec implements the §2.4.7/§2.4.8 subset of that matrix scoped to per-room moderation (kick, ban, unban, promote, demote, ban-list view). Delete-any-message and platform-admin tooling are out of scope (see §2).

## 2. Non-goals

- **Ownership transfer** — §2.4.7 mentions it (v4 REQ-086). Out of scope for this feature; owners either stay owner or the room is deleted. No `POST /rooms/:id/transfer-owner` here.
- **Delete-any-message by admin** — part of v4 REQ-092 role matrix but touches `routes/messages.ts` which is explicitly hands-off in the brief (other agent's territory). Separate spec.
- **Moderation audit log** (v4 REQ-095 `moderation_log` table) — a new table + GET endpoint is wider than §2.4.7/§2.4.8 asks for. Defer to S3.
- **Platform-admin server-wide moderation** (v4 REQ-155..REQ-157) — S3 work.
- **Invitations** — Agent B owns the invitation flow, `InvitationsTab.tsx`, and migration 0008. This spec never touches that surface.
- **Room create/rename/delete/leave/catalog handlers** — shipped on `main`; the brief explicitly forbids edits.
- **Drizzle schema changes for `room_ban`** — schema columns `{id, roomId, userId, bannedById, reason, createdAt}` already match v3.docx §2.4.8 (v4 names it `banned_at`; our column is `created_at` — same semantics, no rename needed). v3.docx `reason` is optional, matches existing nullable column.
- **`ManageRoomModal.tsx` tab-render & dialog wrapper** — hands-off per brief. This spec only widens the `Role` type union at `ManageRoomModal.tsx:30` + `SettingsTab.tsx:16` and gates tab visibility on `role !== "member"` (approved Q2); it does NOT touch the `<Dialog>` shell, the `<Tabs>` layout, or SettingsTab's tab-render logic.

### Scope expansion acknowledged — server-side socket leave IS in scope (REQ-208)

Original brief assumed `apps/backend/src/socket.ts` already removed sockets from the room channel on `room_member` delete. Verification (human, 2026-04-19) found the opposite:

- [apps/backend/src/socket.ts](../../apps/backend/src/socket.ts) is 49 lines of bootstrap (Server + Redis adapter + `connectionStateRecovery` with a 2-minute window). No room-member-delete handler.
- [apps/backend/src/socket-handlers.ts:122-124](../../apps/backend/src/socket-handlers.ts#L122-L124) only handles client-initiated `room.unsubscribe`.
- `connectionStateRecovery` (maxDisconnectionDuration = 2 min) actively RESUMES subscriptions on reconnect unless the server forcibly removes them — so even if a kicked user's socket drops, a fresh socket within 120 s silently re-joins the room channel.

Therefore REQ-208 is NOT verify-only: this spec IMPLEMENTS server-side `io.in(target.socketId).socketsLeave(roomId)` (or equivalent — see §5 socket-leave design) inside the REQ-203/REQ-204 kick transactions. That bypasses the connection-state-recovery path because the server no longer considers the socket subscribed when it reconnects. The broader "subscribe" gate in `socket-handlers.ts` already rejects non-members, so a post-recovery resume that carries a stale room-id will fail its membership check and the join ack returns `{ok:false}`.

## 3. User stories

- As Alice (owner of `#general`), I open Manage Room → Members → "Make admin" on Carol's row, so Carol can help me moderate without giving her delete-room power. (v3.docx §2.4.7)
- As Carol (promoted admin), I open Manage Room → Members → "Remove from room" on Bob's row after he spams, so Bob is kicked and auto-banned per §2.4.8 ("removal is treated as a ban"). Bob's socket leaves the room channel; his rejoin attempt returns 403. (v3.docx §2.4.7, §2.4.8)
- As Alice, I open Manage Room → Banned → find Bob's row → click "Unban", so Bob can attempt to rejoin via the catalog. (v3.docx §2.4.8)
- As Alice, I open Manage Room → Admins → try to click "Remove admin" on my own row (owner) — the button is absent or disabled, because owner cannot lose admin rights (v3.docx §2.4.7 + v4 REQ-093).
- As Bob (member), I open Manage Room if the shell even lets me through (it doesn't today — see §8 Q2) → Members tab shows *no* action buttons, because members have no moderation power.

## 4. Requirements (testable)

`pnpm trace` greps `tests/` + backend test files for each REQ-ID. Every `describe`/`test`/`it` name MUST embed the REQ-ID so the coverage check passes. Format: `REQ-\d{3,}` (enforced by `scripts/trace-req-ids.mjs`).

### Schema / migration

- [ ] **REQ-200**: Migration `infra/migrations/0007_room_roles.sql` is idempotent and performs exactly the backfill — `UPDATE room_member SET role='owner' WHERE (room_id, user_id) IN (SELECT id, owner_id FROM room WHERE owner_id IS NOT NULL)`. The enum, column, and `room_ban` table are already created in `0000_chilly_whirlwind.sql` (verified); 0007 does NOT re-declare them. Migration must be safe to re-run (e.g. fresh clones that already have owner='owner' from the create-room handler since c84948c). Acceptance: run migration twice on a DB that already has `#general` with a member-role owner row — first run flips to 'owner', second run is a no-op (0 rows affected). Unit test: `0007_room_roles.sql` applied against a seeded Postgres in the backend test harness, asserted by `SELECT role FROM room_member WHERE room_id=$general AND user_id=$general_creator` returning `'owner'`.

### Backend — promote / demote

- [ ] **REQ-201**: `POST /api/v1/rooms/:id/admins/:userId` — owner-only. 404 if room missing. 403 with `{error: "not_owner"}` if caller is not the room's owner. 404 with `{error: "user_not_member"}` if target is not a `room_member`. Otherwise `UPDATE room_member SET role='admin' WHERE room_id=:id AND user_id=:userId AND role='member'` — idempotent (promoting an already-admin is 200 with `{promoted: false}`; promoting an owner is 409 with `{error: "already_owner"}`, belt-and-braces for v3.docx §2.4.7 "owner cannot lose admin rights"). On a new promotion (`role=member → admin`), emit Socket.IO `room.role.changed` to the room channel. Response `{promoted: boolean, role: "admin"}`.
- [ ] **REQ-202**: `DELETE /api/v1/rooms/:id/admins/:userId` — owner-only. Demotes `admin → member`. Refuses to demote the owner: 409 with `{error: "cannot_demote_owner"}` per v3.docx §2.4.7 ("owner cannot lose admin rights"). Idempotent (demoting a plain member is 200 with `{demoted: false}`). On a real demotion, emit `room.role.changed`. Response `{demoted: boolean, role: "member"}`.

### Backend — kick / ban / unban / list

- [ ] **REQ-203**: `DELETE /api/v1/rooms/:id/members/:userId` — kick-as-ban per v3.docx §2.4.8. Caller role must be `owner` or `admin` (403 `{error: "not_admin"}` otherwise). Target must be a `room_member`; 404 `{error: "user_not_member"}` if not. Refuses to kick the owner: 409 `{error: "cannot_kick_owner"}`. Admins cannot kick fellow admins unless the caller is owner — 403 `{error: "admin_cannot_kick_admin"}` (prevents admin-vs-admin wars, matches v3.docx §2.4.7 hierarchy intent). Transaction: INSERT `room_ban (roomId, userId, bannedById=caller, reason=null)` ON CONFLICT (room_id, user_id) DO NOTHING → DELETE `room_member WHERE room_id=:id AND user_id=:userId` → emit `room.member.kicked` to the room channel. Response `{kicked: true, banned: true}`.
- [ ] **REQ-204**: `POST /api/v1/rooms/:id/bans` body `{userId, reason?}` — explicit pre-emptive ban (target MAY not be a current member). Caller must be owner/admin. `reason` is optional, ≤ 500 bytes (zod validation). If target is an existing `room_member`, the handler also deletes the membership row + emits `room.member.kicked` (same semantics as REQ-203 with `reason` attached). If target is not a member, just insert the `room_ban` row + emit `room.member.banned` (NEW event — not reserved in protocol.ts as a separate payload from `kicked`; but brief lists `room.member.banned` as reserved). Idempotent: existing active ban returns 409 `{error: "already_banned"}`. Response on success: `{banned: true, kicked: boolean}`.
- [ ] **REQ-205**: `DELETE /api/v1/rooms/:id/bans/:userId` — owner/admin unbans. 404 `{error: "ban_not_found"}` if no active ban. On success, `DELETE FROM room_ban WHERE room_id=:id AND user_id=:userId` + emit `room.member.unbanned` to the room channel. Response `{unbanned: true}`. After unban, the target MAY `POST /rooms/:id/join` again via the existing S2 rooms handler — we don't re-enroll automatically.
- [ ] **REQ-206**: `GET /api/v1/rooms/:id/bans` — owner/admin only. 403 `{error: "not_admin"}` for plain members. Response `{bans: Array<{userId, username, bannedById, bannedByUsername, reason: string|null, bannedAt: string (ISO)}>}` ordered by `bannedAt DESC`. Join `user` twice (once for target, once for actor) to resolve usernames; no N+1. `bannedAt` is the column alias for `room_ban.created_at` on the wire (spec-level rename, DB column stays `created_at`).

### Socket.IO broadcast payloads (replaces `{}` stubs in `protocol.ts`)

- [ ] **REQ-207**: Fill protocol.ts payloads. Fanout target: `server.to(roomId).emit(...)`. At-most-once best-effort — no watermark, no replay; ADR-0003's ordering contract is scoped to message events.
  - `RoomRoleChangedEvent`: `{type, roomId, userId, role: "admin"|"member", changedBy: string, changedAt: string}` — fires on promote (admin) + demote (member).
  - `RoomMemberKickedEvent`: `{type, roomId, userId, kickedBy: string, kickedAt: string}` — fires on REQ-203.
  - `RoomMemberBannedEvent`: `{type, roomId, userId, bannedBy: string, reason: string|null, bannedAt: string}` — fires on REQ-204 pre-emptive path only (non-member ban). If the caller also kicks an existing member via REQ-204, we fire `room.member.kicked` (not `banned`) — `kicked` is the stronger signal that client-side should leave the room channel, and broadcasting both would be redundant.
  - `RoomMemberUnbannedEvent`: `{type, roomId, userId, unbannedBy: string, unbannedAt: string}` — fires on REQ-205.

### Backend — server-forced socket leave on kick/ban (implement)

- [ ] **REQ-208**: After a kick (REQ-203) or explicit-ban-of-an-existing-member (REQ-204 kick-path), every one of the target user's connected sockets currently subscribed to the room channel MUST stop receiving broadcasts to that room within 500 ms. Implementation (not verification — the disconnect hook assumed by the brief does not exist, see §2 scope expansion): inside the same transaction, after the `room_member` DELETE, call `io.in(roomId).fetchSockets()` → filter to sockets whose auth context matches `target.userId` → `socket.leave(roomId)` for each, OR use `io.to(targetUserRoom).socketsLeave(roomId)` if every authenticated socket is already auto-joined to a per-user namespace `user:${userId}` (check socket-handlers.ts join flow in §5 design notes). Test shape — dual-socket integration: Bob connects two sockets → both subscribe `room:general` → Alice kicks Bob via REQ-203 → within 500 ms both Bob sockets receive `room.member.kicked` and a subsequent `server.to('general').emit('message.new', ...)` is NOT observed on either Bob socket. Include an assertion that a fresh Bob socket connected within the 2-minute `connectionStateRecovery` window does NOT resume the room subscription (membership gate in the subscribe handler at socket-handlers.ts:101-110 already rejects non-members with `{ok:false}`; REQ-208 test re-asserts that invariant end-to-end).

### Web UI — Manage Room tabs

- [ ] **REQ-209** (MembersTab): Table columns `Username | Status | Role | Actions`. `Username` = `user.username`; `Status` = presence pill (reuse `PresencePill` from Wave A presence work — already wired to `presence.changed`); `Role` = `owner`/`admin`/`member` badge. Actions column is caller-role-gated:
  - Viewer is `member`: no action buttons rendered.
  - Viewer is `admin`: `[Ban]` + `[Remove from room]` on rows where target is `member`; no buttons on admin/owner rows.
  - Viewer is `owner`: `[Make admin]` on `member` rows; `[Ban]` + `[Remove from room]` on `member` + `admin` rows; no buttons on own owner row.
  - All destructive actions (`Ban`, `Remove from room`) open a confirm modal per v3.docx §4.5 ("administrative actions ... implemented through modal dialogs"). Ban modal also exposes an optional `reason` textarea (≤ 500 chars) posted as the `reason` field to REQ-204 — no, actually REQ-203 kick-as-ban path doesn't take a reason; for reason-carrying bans the user uses the separate pre-emptive ban flow. Decision locked: `Remove from room` does REQ-203 (reason=null); `Ban` does REQ-204 with reason. See §8 Q5.
- [ ] **REQ-210** (AdminsTab): list of admins (fetched via the existing `GET /rooms/:id/members` roster endpoint at [apps/backend/src/routes/rooms.ts:330](../../apps/backend/src/routes/rooms.ts#L330), extended to include `role` — this is a single-column addition, not a breaking change, see §5 for rationale). Owner row is labelled "Owner (cannot lose admin rights)" with no action button. Admin rows show `[Remove admin]` button for owner viewer only; hidden for admin/member viewers (belt and braces — REQ-202's server gate is authoritative). Click opens a confirm modal per §4.5; POSTs to REQ-202. On 409 (`cannot_demote_owner`) surface a toast.
- [ ] **REQ-211** (BannedTab): Table columns `Username | Banned by | Date/time | Actions ([Unban])`. Owner/admin viewer only — if a plain member somehow reaches this tab (see §8 Q2), show an empty-state placeholder "Only admins can view the ban list." Fetches REQ-206. `[Unban]` opens a confirm modal; success triggers optimistic row removal + refetch. On `room.member.unbanned` socket event (receive path — any client open on this tab reacts), the row is removed live.

## 5. Design notes

### Data model / migration

No schema changes. `0007_room_roles.sql` contains ONLY the backfill SQL from REQ-200. Drizzle schema in `packages/shared/src/schema.ts` already reflects the post-state (enum + column + ban table), so no edit there. DTO file gets new zod shapes for the five endpoints (see below).

### Endpoint ownership

Two options — the brief grants discretion:

- **(A)** Add a `// AGENT-A: moderation` marker block inside `apps/backend/src/routes/rooms.ts` and land the five routes there alongside catalog/join/leave.
- **(B)** Create a new file `apps/backend/src/routes/room-moderation.ts` and `app.register` it next to `rooms.ts`.

Choice: **(B)**. Rationale — `rooms.ts` is 588 lines with dense ordering rules for 404/403/409 across catalog/join/leave handlers; adding five more routes with their own ordering discipline makes the file harder to grep. A sibling file keeps the moderation block reviewable in isolation and avoids merge-conflict risk with any unrelated rooms.ts edit on `main` during wave1. Both files mount under the same `/api/v1` prefix via the existing plugin registration pattern.

### Zod DTOs (`packages/shared/src/dto.ts` additions)

```ts
export const promoteAdminResponse = z.object({ promoted: z.boolean(), role: z.literal("admin") });
export const demoteAdminResponse = z.object({ demoted: z.boolean(), role: z.literal("member") });
export const kickMemberResponse = z.object({ kicked: z.literal(true), banned: z.literal(true) });
export const createBanBody = z.object({ userId: z.string(), reason: z.string().max(500).optional() });
export const createBanResponse = z.object({ banned: z.literal(true), kicked: z.boolean() });
export const unbanResponse = z.object({ unbanned: z.literal(true) });
export const banListItem = z.object({
  userId: z.string(),
  username: z.string(),
  bannedById: z.string(),
  bannedByUsername: z.string(),
  reason: z.string().nullable(),
  bannedAt: z.string().datetime(),
});
export const banListResponse = z.object({ bans: z.array(banListItem) });
```

### Existing roster endpoint extension

`GET /api/v1/rooms/:id/members` at [apps/backend/src/routes/rooms.ts:330](../../apps/backend/src/routes/rooms.ts#L330) returns `{ id, username, displayName }[]`. We extend it to return `{ id, username, displayName, role }[]`. This is additive — no existing caller breaks; `RoomClient.tsx`'s presence-pill binding doesn't care about the new field. This edit violates the strict reading of "don't touch rooms.ts create/rename/delete/leave/catalog handlers" — BUT the roster endpoint is none of those, and the brief lists "moderation block" as our territory. We'll extend the existing SELECT to `LEFT JOIN` or add `roomMember.role` to the projection; test with a dedicated REQ-209 unit in MembersTab. If the human would prefer a parallel endpoint (e.g. `GET /api/v1/rooms/:id/roster-with-roles`), see §8 Q3.

### Role badge + presence pill reuse

`PresencePill` from Wave A (shipped in the roster endpoint fix commit `4b4168e`) is the presence source. Role badges are new — implement as a small `<RoleBadge role={"owner"|"admin"|"member"}>` shadcn `Badge` wrapper with `variant="default"` for owner, `variant="secondary"` for admin, hidden for member (keeps table rows scannable). Lives in `apps/web/src/components/chat/manage-room/RoleBadge.tsx` (new file, owned by this spec — listed for clarity even though the brief only names the three tab files).

### Modal dialogs for destructive actions

v3.docx §4.5 mandates modal confirmation for administrative actions. Reuse shadcn `AlertDialog` (already in the project). Three modals:

- Kick confirm: "Remove {username} from #{roomName}? They will be banned and cannot rejoin until unbanned."
- Ban confirm (with reason textarea): "Ban {username} from #{roomName}? Optional reason (≤ 500 chars, shown to other admins)."
- Demote confirm: "Remove admin rights from {username}?"
- Unban confirm: "Unban {username}? They will be able to rejoin #{roomName}."

Promote ("Make admin") is a single-click action without a modal — cheap to reverse via Demote, so confirming would be friction per standard UX patterns. If the human wants symmetric confirmation, §8 Q6.

### Security / auth

Every handler goes through `requireFriendshipAuth` (session-cookie auth used by all `/api/v1/rooms/*` handlers today) → role-check against `room_member.role` via a single SELECT per request. No RLS changes; access control lives in the handler. All five write handlers are idempotent or idempotent-adjacent (409 on duplicate state) so double-click + network retry don't create orphan rows.

Rate limiting: verified 2026-04-19 — the project does NOT use `@fastify/rate-limit` per-route config. It uses hand-rolled Redis INCR+EXPIRE buckets per concern (see `apps/backend/src/lib/room-create-rate-limit.ts`, `room-join-rate-limit`, `room-mgmt-rate-limit`, `friend-rate-limit`). Writing a sixth bucket helper + a dual-tier burst/sustained test matrix is ~4h of work that does not improve the demo story. **Punting moderation rate-limiting to FOLLOWUPS.md** per the human's directive; the five moderation handlers land without rate-limiting in this spec. Belt-and-braces: the REQ-202/REQ-203/REQ-204/REQ-205 handlers remain owner/admin-gated at the DB-query level, so a compromised session still cannot exceed the role matrix.

### Socket-leave design for REQ-208 (locked)

Verified 2026-04-19 during pre-TDD tech-debt sweep: every authenticated socket already auto-joins a per-user channel `user:${userId}` at [apps/backend/src/socket-auth.ts:44](../../apps/backend/src/socket-auth.ts#L44) — the same channel the friendship-accepted event broadcasts over ([apps/backend/src/routes/friendship.ts:411](../../apps/backend/src/routes/friendship.ts#L411)). REQ-208 reuses it:

```ts
// inside the REQ-203 / REQ-204 kick-path transaction, AFTER the room_member DELETE:
await io.in(`user:${targetUserId}`).socketsLeave(roomId);
io.to(roomId).emit("room.member.kicked", { ... });
```

`socketsLeave` is a single cluster-wide call over the Redis adapter — it affects every Bob socket, on any backend process, in one RTT. No `fetchSockets` iteration, no `socket.data.userId` plumbing. The dual-socket test in REQ-208 is the authoritative assertion; the connection-state-recovery resume test (REQ-208 §4) backstops the invariant that a 2-min reconnect still re-hits the membership gate at `socket-handlers.ts:101-110`.

## 6. Tasks (8, each <2h — TDD discipline per CLAUDE.md §Workflow)

**Pre-task hazard notice (from FOLLOWUPS.md, read before Task 2+)**: the "Backend sign-up rate-limit bleed across test files" row — chaining `room-moderation.test.ts` next to `room-patch.test.ts` / `room-delete.test.ts` in one vitest fork will exhaust better-auth's `customRules["/sign-up/email"]` bucket (5 / 3600s) and subsequent sign-up calls return 404. Mitigation (test-local, reverted per-file): in `tests/setup.ts`-equivalent `beforeEach`, call `auth.api.clearRateLimits?.()` if the method is exposed; otherwise delete the `ratelimit:*` Redis keys for the sign-up bucket alongside the existing `flushRedis()`. Do NOT raise `customRules` `max` in test env — that masks the bleed without fixing it. The "dto-room.test.ts vitest-types" row is already handled by this spec's §9 per-workspace typecheck gate.

1. [ ] **Spec review** — this doc, Q1–Q6 in §8 resolved by human. No code yet.
2. [ ] **REQ-200 backfill migration** — write failing backend integration test that inserts a `room_member` row for the owner with `role='member'`, applies 0007, asserts `role='owner'`. Implement 0007. Commit.
3. [ ] **REQ-201 + REQ-202 (promote / demote)** — failing test for happy + all five 403/404/409 branches (including REQ-093 cannot-demote-owner). Implement handlers + DTOs + protocol `room.role.changed` payload. Commit.
4. [ ] **REQ-203 (kick-as-ban) + REQ-208 socket leave for kick** — failing tests: (a) happy + 403 non-admin + 409 cannot-kick-owner + 403 admin-cannot-kick-admin + idempotent ban insert (DB-level); (b) dual-socket integration — Bob holds two sockets subscribed to `room:general`; Alice kicks via REQ-203; within 500 ms both Bob sockets observe `room.member.kicked` AND a subsequent `message.new` broadcast to `general` is NOT received by either Bob socket. Implement handler + `socketsLeave` call (§5 design). Commit.
5. [ ] **REQ-204 + REQ-205 + REQ-206 + REQ-208 for ban-of-existing-member** — failing tests: (a) pre-emptive ban, unban, ban list happy + 409 already-banned + 404 ban-not-found + 403 member-gets-ban-list (DB-level); (b) REQ-204 when target IS a current member: dual-socket integration mirroring Task 4 — Bob's sockets must also stop receiving broadcasts within 500 ms; (c) connection-state-recovery resume test — Bob's kicked socket reconnects within the 2-min recovery window and attempts `room.subscribe(general)`; the existing membership gate at `socket-handlers.ts:101-110` returns `{ok:false}` because `room_member` row is gone. Implement handlers + payloads. Commit.
6. [ ] **REQ-207 protocol payloads** — replace the four `{}` stubs with real interfaces. TypeScript compile failure drives the test here (a test file imports the event and fails to compile if the payload is still `{}`). Commit.
7. [ ] **REQ-209/210/211 UI** — implement MembersTab, AdminsTab, BannedTab. Vitest + React Testing Library for role-gated button visibility; Playwright deferred to dual-browser smoke below. Extend roster endpoint (per §5) in the same commit. Commit.
8. [ ] **REQ-208 dual-browser smoke** — Alice(Chrome) + Bob(Firefox) + Carol(Edge): Carol kicks Bob → Bob's socket drops → rejoin 403. Alice unbans Bob → Bob rejoins + sees history. Alice demotes Carol → Carol's action buttons disappear live. Alice tries to demote herself → 403. Record result in FOLLOWUPS.md if anything defers. Commit docs-only if smoke passes; tag kill-switch cuts in FOLLOWUPS.md if anything deferred.

## 7. Out of scope / follow-ups

- **Ownership transfer (v4 REQ-086)** — separate spec.
- **Admin delete-any-message (v4 REQ-092 row)** — touches `routes/messages.ts`, different agent territory.
- **`moderation_log` audit table + GET endpoint (v4 REQ-095)** — S3 work.
- **Platform-admin server-wide moderation (v4 REQ-155..REQ-157)** — S3 work.
- **Ban reason on kick-as-ban path (REQ-203)** — current design sets `reason=null` for kick path; a future enhancement could let admins type a reason during Remove-from-room. Low value for demo; punt.
- **Socket drop hardening** — if REQ-208 turns up a bug in `socket.ts` disconnect handling, it fixes under that REQ-ID but the broader "defensive disconnect on every role change" idea is deferred.
- **Optimistic UI for promote/demote** — UI polish; ship with refetch-after-mutation for now.

## 8. Open questions (MUST resolve before approval)

All six resolved 2026-04-19 (human sign-off):

- [x] **Q1 — APPROVED**: `0007_room_roles.sql` is backfill-only with a `-- DDL lives in 0000_chilly_whirlwind.sql` header comment. No-op second-run is required; **test-first** (REQ-200 Task 2 in §6).
- [x] **Q2 — APPROVED (minimum-edit widen)**: `Role = "owner" | "admin" | "member"` at `ManageRoomModal.tsx:30` AND `SettingsTab.tsx:16` (both declare the same union). Expose the three moderation tabs when `role !== "member"`. **Type widening + tab-visibility gate only** — do NOT touch SettingsTab's tab-render logic; admin-vs-owner settings behaviour is out of scope.
- [x] **Q3 — APPROVED**: Extend `GET /api/v1/rooms/:id/members` with a `role` field. Additive. Update the roster DTO in `packages/shared/src/dto.ts` alongside.
- [x] **Q4 — REVISED (premise was wrong)**: Original Q4 asked whether `socket.ts` already handled disconnect-on-member-delete. Verification found: (1) `socket.ts` is 49 lines of bootstrap only, no such handler anywhere; (2) `connectionStateRecovery` with a 2-minute window actively resumes subscriptions unless the server forcibly removes them. **REQ-208 is now in-scope implementation, not verification**. Scope expansion written into §2 and §5; Tasks 4 and 5 in §6 carry the 500 ms dual-socket assertion. No separate FOLLOWUPS entry — the work lands under REQ-208 in this spec.
- [x] **Q5 — APPROVED**: REQ-203 kick sets `reason=null`. REQ-204 carries the reason channel.
- [x] **Q6 — APPROVED**: No modal confirmation on promote. Demote + Remove + Ban + Unban retain their confirm modals.

## 9. Gate criteria (self-check before "done")

- [ ] `pnpm --filter backend test:run` green (all REQ-200..REQ-208 branches exercised).
- [ ] `pnpm --filter web test:run` green (MembersTab/AdminsTab/BannedTab role-gated render tests).
- [ ] `pnpm typecheck` per workspace green.
- [ ] `pnpm trace` reports REQ-200..REQ-211 covered.
- [ ] Manual dual-browser smoke completed (§6 task 8); results recorded in this report + FOLLOWUPS.md.
- [ ] Modal layout matches Appendix A tab labels + column headers (not pixel-perfect — shadcn defaults are fine).
- [ ] `FOLLOWUPS.md` updated with any kill-switch cuts (brief §Kill-switch: demote → banned-by-column → pre-emptive-ban, in that order).
- [ ] No `git push`. No `git remote add`. Local branches only.

## 10. Acceptance test outline (REQ → test mapping)

| REQ-ID | v4 cross-ref | How exercised | Layer |
| --- | --- | --- | --- |
| REQ-200 | — (prep) | Fresh Postgres: seed #general with creator at role='member', apply 0007, assert `role='owner'` | migration integration |
| REQ-201 | REQ-092 promote row | Owner promotes member → 200; non-owner → 403; non-member target → 404; promoting owner → 409; idempotent repeat → 200 `{promoted:false}` | backend integration |
| REQ-202 | REQ-092 demote row + REQ-093 | Owner demotes admin → 200; owner demotes owner → 409 `cannot_demote_owner`; idempotent repeat on member → 200 `{demoted:false}` | backend integration |
| REQ-203 | REQ-091 kick-is-ban | Admin kicks member → 200 + ban row exists + member row gone + `room.member.kicked` emitted; admin kicks admin → 403 (unless caller=owner) | backend integration + socket |
| REQ-204 | REQ-090 + REQ-091 ban definition | Pre-emptive ban of non-member → 200; pre-emptive ban of member → 200 + kick semantics; duplicate active ban → 409 | backend integration |
| REQ-205 | REQ-090 | Unban → 200; unban non-existent → 404; `room.member.unbanned` emitted | backend integration + socket |
| REQ-206 | REQ-094 ban audit view | Admin GET → 200 with `bannedByUsername` populated; member GET → 403 | backend integration |
| REQ-207 | — (wire contract) | TypeScript compile check on protocol.ts consumers — failing compile if stub `{}` survives | type-level |
| REQ-208 | REQ-090 §3 "loses WS subscription" | Bob holds 2 sockets → Alice kicks → within 500ms both observe `room.member.kicked`; subsequent `message.new` to `general` not received on either; fresh Bob socket reconnect within 2-min recovery window attempts subscribe → `{ok:false}` from membership gate | dual-socket integration (server-leave implemented, not verify-only) |
| REQ-209 | REQ-092 role matrix | RTL: render MembersTab as owner/admin/member, assert button visibility matches §4 REQ-209 table | web unit |
| REQ-210 | REQ-093 owner-always-admin | RTL: AdminsTab as owner shows [Remove admin] on admin row, shows "Owner (cannot lose admin rights)" on owner row with no button | web unit |
| REQ-211 | REQ-094 | RTL: BannedTab hits mocked REQ-206, renders table; click [Unban] fires confirm + REQ-205 | web unit |

---

**Approval request**: human, please review §2 non-goals, §4 REQ list, §8 open questions (especially Q2 `ManageRoomModal` type widen — this is the only edit that strays near a brief-marked hands-off file). Once approved, I'll TDD from task 2 in §6. No implementation will start before approval.
