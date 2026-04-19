# Spec: S2 — Private rooms + invitations

**Status**: approved 2026-04-19 (Q1/Q2/Q3 resolved — see §8)
**Branch**: `feat/invitations` (worktree at `../hackaton-invitations`, off `main` @ `c84948c`)
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code — wave1 agent B
**Scope**: REQ-088 (private-room catalog exclusion, already shipped — audited by test here), REQ-089 (private-room invitations), REQ-089a (invitation lifecycle — expiry 14d + inviter-cancel). REQ-089b is **knowingly diverged** (public-room invites allowed per approved Q1); REQ-089a per-user 50/24h rate limit and invitee-block silent-drop are deferred to S3 per §2.

## 1. Why

Today every group room is `visibility='public'` and self-joinable (s2-rooms REQ-025/026). There is no way to create a private space or to invite a specific user — `POST /rooms` hardcodes `visibility: 'public'` ([apps/backend/src/routes/rooms.ts:293](../../apps/backend/src/routes/rooms.ts#L293)), and REQ-088/089 are unimplemented. Without this, private core-team coordination (the canonical demo scenario — "Alice creates core-team, invites Bob") is impossible and v4 §5.5 room moderation has nothing to moderate. Wave1 agents A (roles/kicks/bans) and C (edit/delete replies) depend on invitations existing to exercise their flows against a realistic private room.

## 2. Non-goals

- **Role promotion / kick / ban** — agent A's spec (`feat/room-roles`). We only READ `room_member.role` (from migration `0007`); we never INSERT/UPDATE a role.
- **Per-user 50/24h outgoing-invite rate limit (REQ-089a)** — deferred to S3 hardening. Tracked in FOLLOWUPS.md after merge; we still persist `createdAt` so a future limiter can window over it. See §8 Q4.
- **Expired-invite GC sweep** — REQ-089a expiry is enforced lazily at read (we filter `status='pending' AND expiresAt > now()` in `GET /invitations` and in the 409-duplicate check). A cron GC flips `pending → expired` at some future tick; that's a REQ-157 scheduler job, not ours.
- **Silent-drop-on-user-block (REQ-089a) when invitee has blocked inviter** — v4 §2.3.3 user-to-user block. Deferred: detect path exists but needs s2-friendship's `user_block` table plumbed. See §8 Q5.
- **Federation of invitations (S4)** — invites are server-local.
- **Invite-by-email** — only invite-by-username for hackathon demo.
- **Bulk invite** — one username per POST.

## 3. User stories

- As Alice, I create a room with Public/Private radio set to **Private**, so `core-team` does not appear in Bob's catalog. (REQ-088)
- As Alice (admin of `core-team`), I enter the Invitations tab of Manage Room, type `bob`, click "Send invite", and Bob gets a live notification + a pending entry in his Inbox. (REQ-089)
- As Bob, I see the pending invite in my `/rooms` sidebar Inbox, click **Accept**, and `core-team` now appears in my sidebar with full history. (REQ-089)
- As Bob, I see the pending invite and click **Decline**; Alice sees the decline event; the invite is no longer in my inbox. (REQ-089)
- As Alice, if I try to invite Bob twice in a row, the second call is 409 `invite_pending`. (REQ-089a de-dupe)
- As Alice, if I try to invite Carol who is in `room_ban` for `core-team`, I get 403 `invitee_banned`. (interacts with agent A's REQ-090; runtime-gated on `room_ban` table presence — see §5 "Cross-agent coordination")
- As Alice, my invite auto-expires after 14 days (REQ-089a); the inbox no longer shows it after `expiresAt`.
- As Alice, I can cancel my outgoing invite via the Invitations tab; Bob's inbox updates in real time (inviter-initiated cancel = `DELETE /invitations/:id` → status `declined` → fanout to invitee).

## 4. Requirements (testable)

`pnpm trace` greps `tests/` for each REQ-ID. `describe`/`test` names MUST embed them.

- [ ] **R1 (REQ-088, catalog audit)**: `GET /api/v1/rooms` (catalog) does NOT include rooms created with `visibility='private'` for a non-member caller. `GET /api/v1/rooms/me` DOES include private rooms the caller is a member of. No code change to `rooms.ts` catalog handler — this is a **test-only audit** over the existing filter at [rooms.ts:204](../../apps/backend/src/routes/rooms.ts#L204). Trace-ID: REQ-088.

- [ ] **R2 (REQ-088, create)**: `POST /api/v1/rooms` accepts `{ name, description?, visibility: 'public' | 'private' }`. Default `'public'` when omitted. The stored `room.visibility` equals the input. Response `roomCreateResponseSchema.visibility` becomes a union, not the current `z.literal('public')`. Trace-ID: REQ-088.

- [ ] **R3 (REQ-089, invite)**: `POST /api/v1/rooms/:id/invitations` body `{ inviteeUsername }`:
  - 401 if no session.
  - 404 if room does not exist or is soft-deleted.
  - 403 `not_a_member` if caller is not a `room_member` of `:id`.
  - For `visibility='private'`: 403 `forbidden_role` unless caller's `room_member.role IN ('owner','admin')` (role column comes from agent A's `0007` migration). Matches REQ-092 "Invite to private room: Admin+/Owner".
  - For `visibility='public'`: any member may invite (approved Q1 divergence from REQ-089b — logged in FOLLOWUPS.md at merge).
  - 404 `invitee_not_found` if no user matches `inviteeUsername` (case-insensitive via `citext` as used in friendship lookups).
  - 409 `invitee_already_member` if invitee is already in `room_member` for `:id`.
  - 409 `invite_pending` if a row exists in `room_invitation` for `(roomId=:id, inviteeId, status='pending')` with `expiresAt > now()`.
  - 403 `invitee_banned` if `room_ban` row exists for `(roomId=:id, userId=inviteeId)`. Runtime-gated (§5 "Cross-agent coordination"): if agent A's `0007` has not landed the `room_ban` table at migrate time, the SELECT is skipped and the 403 branch is unreachable until A merges; behaviour flag `INVITATIONS_ENFORCE_BAN` (default `true`).
  - On success: INSERT `room_invitation (id, roomId, inviterId, inviteeId, status='pending', createdAt=now(), expiresAt=now()+interval '14 days')` per approved Q2.
  - Emit `room.invitation.sent` to Socket.IO user channel `user:{inviteeId}` with payload `{ type, invitationId, roomId, roomName, inviterId, inviterUsername, createdAt, expiresAt }`.
  - Response `201 { invitationId, expiresAt }`.
  - Trace-ID: REQ-089.

- [ ] **R4 (REQ-089, inbox)**: `GET /api/v1/invitations` returns the caller's pending invites **as invitee** with `status='pending' AND expiresAt > now()`, joined with `room.name` and `inviter.username`. Shape: `{ invitations: Array<{ id, roomId, roomName, inviterUsername, createdAt, expiresAt }> }`. 401 if no session. Ordered by `createdAt DESC`. Trace-ID: REQ-089.

- [ ] **R5 (REQ-089, accept)**: `POST /api/v1/invitations/:id/accept`:
  - 401 if no session.
  - 404 if invitation does not exist.
  - 403 `not_invitee` if caller is not `inviteeId`.
  - 409 `invitation_not_pending` if status is not `pending` OR `expiresAt <= now()`.
  - In a single transaction: UPDATE `status='accepted', respondedAt=now()`; INSERT `room_member (roomId, userId=caller, role='member')` ON CONFLICT DO NOTHING (covers race where invitee was added via another path between send and accept).
  - Emit `room.invitation.accepted` to `user:{inviterId}` with `{ type, invitationId, roomId, inviteeId, inviteeUsername, acceptedAt }`.
  - Also emit the existing `room.member.joined` to the room channel (reuses s2-rooms event).
  - Response `200 { joined: true, roomId }`.
  - **Atomicity test (MUST):** in addition to the happy-path assertion, a test forces a failure inside the transaction (throw after the UPDATE but before the INSERT via a spy on `roomMember` insert) and asserts that `room_invitation.status` rolled back to `'pending'` — i.e. no half-applied state. Covers the REQ-089 guarantee "MUST accept or decline; they are not auto-joined".
  - Trace-ID: REQ-089.

- [ ] **R6 (REQ-089, decline)**: `POST /api/v1/invitations/:id/decline`:
  - Same auth / 404 / 403 shape as R5.
  - 409 `invitation_not_pending` if status is not `pending`.
  - UPDATE `status='declined', respondedAt=now()`. No `room_member` INSERT.
  - Emit `room.invitation.declined` to `user:{inviterId}` with `{ type, invitationId, roomId, declinedAt }`. (Inviter-only notification matches v4 §2.3 "bans are private" ethos — only the inviter learns of the decline; the room itself does not.)
  - Response `200 { declined: true }`.
  - Trace-ID: REQ-089.

- [ ] **R7 (REQ-089, inviter cancel)**: `DELETE /api/v1/invitations/:id`:
  - 401 if no session.
  - 404 if invitation does not exist.
  - 403 `not_inviter` if caller is not `inviterId`.
  - 409 `invitation_not_pending` if status is not `pending`.
  - UPDATE `status='declined', respondedAt=now()` — reuses existing `declined` enum value; no new enum, no new event (approved Q3).
  - Emit `room.invitation.declined` to `user:{inviteeId}` with `{ type, invitationId, roomId, declinedAt }`. **Asymmetry (binding, not optional):** inviter-cancel fans out to the **invitee's** user channel (so Bob's inbox drops the row); invitee-decline (R6) fans out to the **inviter's** channel. Same event name, different fanout target — reader MUST NOT assume symmetric routing. Documented here instead of only in §8 so it survives into implementation and test names.
  - Response `200 { cancelled: true }`.
  - Trace-ID: REQ-089.
  - **Kill-switch candidate** (brief §Kill-switch #1): if R1–R6 are green but time is tight, cut this endpoint and the Invitations-tab Cancel button. Send + list-outgoing stays. Log in FOLLOWUPS.md.

- [ ] **R8 (REQ-089a, expiry filter)**: `GET /invitations` and the R3 409 de-dupe check both filter by `expiresAt > now()`. A row with `status='pending'` but `expiresAt <= now()` is invisible to the inbox and does NOT block a new invite to the same `(roomId, inviteeId)`. (We still carry the row; a later GC flips status to `expired`, but that's out of scope — see §2.) Trace-ID: REQ-089a.

- [ ] **R9 (dual-browser smoke — not a unit test)**: Appears in the Playwright suite under `tests/e2e/invitations.spec.ts`. Alice (Chrome) + Bob (Firefox) per the multi-user pattern in `feedback_playwright_multi_user.md`. Steps:
  1. Alice creates private room "core-team" → Bob's catalog GET does not show it.
  2. Alice opens ManageRoom → Invitations → types "bob" → sends.
  3. Bob's Inbox shows pending within 2s (via `room.invitation.sent`).
  4. Bob accepts → `core-team` appears in Bob's sidebar → Bob enters → sees existing messages.
  5. Alice invites Carol who is in `room_ban` → 403 `invitee_banned` (SKIP if `INVITATIONS_ENFORCE_BAN=false` due to A slip).
  6. Alice invites Bob again (now a member) → 409 `invitee_already_member`.
  7. Alice sends a fresh invite to Dave → Alice cancels via Invitations tab → Dave's inbox drops it within 2s.
  Trace-IDs: REQ-088, REQ-089.

## 5. Design notes

### Data model — migration `0008_invitations.sql` (spec correction 2026-04-19 post-approval)

**Correction:** the initial migration `0000_chilly_whirlwind.sql` already created a `room_invite` table + `room_invite_status` enum (`'pending','accepted','rejected'`) + full UNIQUE on `(room_id, invitee_id)` as wave-0 scaffolding. The brief's instruction to create a new `room_invitation` table conflicts with that pre-existing scaffold. Evolving the existing table is the clean path:

1. Keep table name `room_invite` (Drizzle symbol `roomInvite`) — renaming would churn migration snapshots, `db-helpers.ts`, and cross-refs for zero semantic gain.
2. RENAME enum value `'rejected'` → `'declined'` (matches spec/event name; rows are fresh scaffolding so zero data risk).
3. ADD enum value `'expired'` (for the future GC sweep — we don't write it ourselves in wave1).
4. ADD column `responded_at timestamptz` (nullable).
5. ADD column `expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days')`.
6. DROP the full UNIQUE `room_invite_room_invitee_uq`; REPLACE with partial `room_invite_room_invitee_pending_uq` WHERE status='pending' (allows multiple historical rows per (room, invitee); only one live pending at a time).
7. ADD index `room_invite_invitee_status_idx` on `(invitee_id, status)`.

Endpoint names, event names, and UI language stay **"invitation"** (human-facing), while the DB name stays `room_invite` (historical).

```sql
-- 0008_invitations.sql
ALTER TYPE "public"."room_invite_status" RENAME VALUE 'rejected' TO 'declined';
--> statement-breakpoint
ALTER TYPE "public"."room_invite_status" ADD VALUE 'expired';
--> statement-breakpoint
ALTER TABLE "room_invite"
  ADD COLUMN "responded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "room_invite"
  ADD COLUMN "expires_at" timestamp with time zone NOT NULL
  DEFAULT (now() + interval '14 days');
--> statement-breakpoint
DROP INDEX IF EXISTS "room_invite_room_invitee_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "room_invite_room_invitee_pending_uq"
  ON "room_invite" ("room_id", "invitee_id")
  WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX "room_invite_invitee_status_idx"
  ON "room_invite" ("invitee_id", "status");
```

Mirrored in `packages/shared/src/schema.ts` by extending the existing `roomInvite` pgTable: add `respondedAt`, `expiresAt`, switch unique to partial on status='pending', add `(inviteeId, status)` index; update `roomInviteStatus` enum values to `['pending','accepted','declined','expired']`.

A user_id cascade on inviter/invitee deletion is fine — REQ-126 soft-delete sets name to "[deleted user]" but the FK uses hard id; we accept the dangling cascade semantics (matches `room_member` behavior).

### Protocol payloads (fill the `{}` stubs reserved on `main`)

```ts
export interface RoomInvitationSentEvent {
  type: "room.invitation.sent";
  invitationId: string;
  roomId: string;
  roomName: string;          // denorm so client can render without fetching room
  inviterId: string;
  inviterUsername: string;   // denorm for toast rendering
  createdAt: string;         // ISO
  expiresAt: string;         // ISO
}

export interface RoomInvitationAcceptedEvent {
  type: "room.invitation.accepted";
  invitationId: string;
  roomId: string;
  inviteeId: string;
  inviteeUsername: string;
  acceptedAt: string;        // ISO
}

export interface RoomInvitationDeclinedEvent {
  type: "room.invitation.declined";
  invitationId: string;
  roomId: string;
  declinedAt: string;        // ISO
}
```

All three events are at-most-once best-effort — same contract as `friend.request.accepted` and `room.member.joined`. No watermark (ADR-0003 scope is room messages). Missed events reconcile on the next `GET /invitations` (invitee) or via UI refetch (inviter).

### Endpoints (new file `apps/backend/src/routes/invitations.ts`)

| Method | Path | Body | Binding |
| --- | --- | --- | --- |
| POST | `/api/v1/rooms/:id/invitations` | `{ inviteeUsername: string }` | R3 |
| GET | `/api/v1/invitations` | — | R4 |
| POST | `/api/v1/invitations/:id/accept` | — | R5 |
| POST | `/api/v1/invitations/:id/decline` | — | R6 |
| DELETE | `/api/v1/invitations/:id` | — | R7 (inviter cancel) |

Registered in `apps/backend/src/server.ts` alongside `registerRoomsRoutes(app)` as `registerInvitationsRoutes(app)`.

### Fanout asymmetry (binding)

Both R6 (invitee declines) and R7 (inviter cancels) transition the row to `status='declined'` and emit the **same event name** `room.invitation.declined`. The routing target differs:

| Action | Actor | Fanout target | Why |
| --- | --- | --- | --- |
| Invitee declines (R6) | `inviteeId` | `user:{inviterId}` | Inviter's "outgoing" list drops the row |
| Inviter cancels (R7) | `inviterId` | `user:{inviteeId}` | Invitee's inbox drops the row |

Accept (R5) is symmetric in the other direction: fanout is to `user:{inviterId}` (the only side who cares — the invitee knows because they clicked). Implementers MUST NOT emit to both channels; that would double-notify and invites race conditions in the inbox UI. Test names should contain the fanout target (e.g. "cancel emits declined event to invitee channel").

### Cross-agent coordination

- **Migration ordering:** `0008_invitations.sql` only ALTERs the pre-existing `room_invite` table + `room_invite_status` enum (both created in `0000`). It does NOT depend on agent A's `0007` at all — `room_ban` and `room_member.role` both already exist since `0000`, so R3's banned-check and admin-role-check work against today's schema.
- **`INVITATIONS_ENFORCE_BAN` kept as a behaviour flag (defensive):** even though `room_ban` exists, the flag stays as per brief guidance ("if A slips, stub the room_ban SELECT behind a feature flag"). Default `true`. Flag flip cost is one env var. Flag removal tracked in FOLLOWUPS.md once wave1 is merged and A's semantic ban flow (populate `room_ban` rows from kick/ban handler) is in.
- **Startup probe:** no longer strictly needed given `room_ban` exists since `0000`, but we still log a one-line `roomBan.count()` at startup so any migration regression is loud. Cheap.
- **No edits to agent A's territory:** `room_member.role` lookup for the private-room admin gate reads the column directly; no migration edit. Agent A owns populating the role values via kick/ban/promote handlers — we just READ.

### `POST /rooms` change (rooms.ts — ONLY the `visibility` field, no other edits)

1. `createRoomSchema` (dto.ts) gains `visibility: z.enum(['public','private']).default('public')`.
2. `roomCreateResponseSchema.visibility` relaxes from `z.literal('public')` to `z.enum(['public','private'])`.
3. Handler passes the parsed `visibility` to the INSERT instead of hardcoded `'public'`, and uses the same value in the response parse. Nothing else in the handler moves (no re-ordering, no rate-limit change, no moderation block touched — owned by agent A).

### UI

- **`CreateRoomDialog.tsx`** — add a `<RadioGroup>` (shadcn) for Public/Private; default Public; plumb into the mutation payload. One-line form-state field addition; the rest of the dialog is untouched.
- **`InvitationsTab.tsx`** (inside ManageRoom) — text input "Invite by username" + submit button; below it, a list of pending-outgoing invites for this room. The inviter-side "cancel" action for a pending invite: see §8 Q3 for endpoint choice.
- **`apps/web/src/components/invitations/InboxList.tsx`** (new) — rendered as a collapsible panel on the `/rooms` sidebar, above the rooms list. Shows incoming pending invites with Accept/Decline buttons. Socket.IO listener on `room.invitation.sent` prepends new entries; optimistic removal on Accept/Decline, with invalidation of `GET /rooms/me` + `GET /invitations`.
- All three pieces use existing shadcn primitives (Button, Input, Card, RadioGroup). Accessibility: each Accept/Decline button includes an `aria-label` naming the room; the Send button disables on empty/invalid username.

### Security / auth

- All endpoints require a valid session via `requireFriendshipAuth` (same helper that s2-rooms uses).
- `room_member` lookup gates the POST invite; `inviteeId === ctx.userId` gates accept/decline.
- The username → userId resolution for R3 is case-insensitive via the existing `citext` username column; invalid chars → 400 not 404.
- CSRF: state-changing endpoints are POST + session-cookie'd, which is the project's existing posture (s3-hardening covers global CSRF). No new attack surface.
- No user enumeration: `invitee_not_found` (404) vs `invitee_already_member` (409) differ — matches friendship spec. The brief does not require constant-time enumeration resistance for this flow.
- Private-room discoverability (REQ-088): catalog filter at `rooms.ts:204` already excludes non-public rooms; R1 adds the test that proves it.

### Rate limits

- `POST /rooms/:id/invitations` — S3 will add per-user 50/24h (REQ-089a). For S2 wave1 we ship without (see §2 / §8 Q4); persist `createdAt` so S3 has the data.
- No rate limit on accept/decline (invitee-initiated, not spam-prone).

## 6. Tasks (9, each <2h)

1. [x] `/spec` review + §8 resolution before implementation (approved 2026-04-19).
2. [ ] Migration `0008_invitations.sql` DDL + mirror in `packages/shared/src/schema.ts` — apply via `pnpm db:migrate` in a fresh test DB; no-op against a prod DB that already has `0007`.
3. [ ] Fill `packages/shared/src/protocol.ts` payloads for the three `room.invitation.*` events (stubs reserved on main); add invitation DTOs to `packages/shared/src/dto.ts`; add `createRoomSchema.visibility` + widen `roomCreateResponseSchema.visibility`.
4. [ ] **TDD R1 + R2** — failing tests for private-room catalog exclusion + private-room create in `apps/backend/tests/private-rooms.test.ts`; implement the `visibility` field change in `rooms.ts` + `createRoomSchema`; green.
5. [ ] **TDD R3** — `apps/backend/tests/invitations.test.ts` covers happy, 401/403/404/409 grid, banned-invitee 403 (flag on) + flag-off skip, socket emit assertion.
6. [ ] **TDD R4/R5/R6/R7/R8** — inbox, accept (happy + forced-rollback atomicity test), decline, inviter-cancel (incl. invitee-channel fanout), expiry filter.
7. [ ] `INVITATIONS_ENFORCE_BAN` env + startup probe for `room_ban` table presence.
8. [ ] UI: `CreateRoomDialog` radio, `InvitationsTab` body, `InboxList` component. Manual render check at `localhost:3000`.
9. [ ] **R9** dual-browser Playwright — Chrome+Firefox per `feedback_playwright_multi_user.md`. Batched smoke at gate, per `feedback_batched_smoke.md`.

## 7. Out of scope / follow-ups

- **REQ-089b divergence** — public-room invites allowed per approved Q1. FOLLOWUPS.md entry at merge explaining rationale so a future compliance pass can re-narrow if needed.
- **Rate limit 50/24h (REQ-089a)** — tracked in FOLLOWUPS.md after merge.
- **Expired-invite GC** — REQ-157 scheduler, not ours.
- **User-block silent-drop (REQ-089a)** — needs `user_block` plumbed; FOLLOWUPS.md.
- **`INVITATIONS_ENFORCE_BAN` flag removal** — once agent A's `0007` is on `main`, the flag becomes always-on; remove the flag + probe + branching test. FOLLOWUPS.md entry.
- **Invitee REMOVES a declined invite from history** — we keep the row for audit. No UI to purge.
- **Notification UI toast on invite accept/decline for inviter** — the socket event is emitted; the toast UI is a nice-to-have deferred if time pressure.
- **Kill-switch #1 (R7 cancel cut)** — if invoked, FOLLOWUPS.md entry records which UI/endpoint was cut and why.

## 8. Open questions — resolved 2026-04-19

- [x] **Q1 — public-room invitations.** APPROVED (a): allow any member to invite on public rooms. Divergence from REQ-089b logged to FOLLOWUPS.md at merge. Rationale: REQ-089b's anti-enumeration purpose is already served by REQ-088 (private rooms excluded from catalog); demo value is real.

- [x] **Q2 — `expiresAt` default.** APPROVED **14 days** (matches REQ-089a). Brief's 7d was copy-paste slip. Default encoded in SQL and in the Drizzle schema mirror.

- [x] **Q3 — Inviter cancel endpoint.** APPROVED (b) `DELETE /api/v1/invitations/:id` → status `declined` (reuses enum + existing event). Fanout asymmetry promoted into §5 "Fanout asymmetry (binding)" so it survives into implementation.

- [x] **Q4 — Per-user 50/24h rate limit.** Deferred to S3; FOLLOWUPS.md entry at merge.

- [x] **Q5 — User-block silent-drop.** Deferred to S3; FOLLOWUPS.md entry at merge.

- [x] **Q6 — Username case-insensitivity.** Confirmed: `citext` lookup matches friendship pattern.

## 9. Gate criteria

Self-check before declaring "wave1 invitations done":

- [ ] `pnpm --filter backend test:run` green — private-rooms + invitations suites pass (R1–R7).
- [ ] `pnpm typecheck` per-workspace green.
- [ ] `pnpm trace` reports REQ-088, REQ-089, REQ-089a as covered (test names embed the IDs).
- [ ] Manual dual-browser smoke (R8): Alice/Chrome + Bob/Firefox — five scenarios above all pass.
- [ ] Stubs filled: `InvitationsTab.tsx` body replaces "coming soon"; three protocol `{}` payloads replaced with typed shapes; `0008_invitations.sql` no longer reserved-only.
- [ ] Hands-off files untouched: `MembersTab.tsx`, `AdminsTab.tsx`, `BannedTab.tsx`, `SettingsTab.tsx`, `routes/rooms.ts` moderation block, `routes/room-moderation.ts`, `routes/messages.ts`, `routes/dms.ts`, `MessageList.tsx`, `MessageComposer.tsx`, `replyTo*` fields. Enforced by reading the diff pre-merge.
- [ ] Kill-switches logged in FOLLOWUPS.md IF any were invoked.

## 10. Acceptance test outline (REQ → test mapping)

| REQ-ID | How exercised | Layer | Test file |
| --- | --- | --- | --- |
| REQ-088 | Private room hidden from catalog for non-member, shown in `/rooms/me` for member | integration | `private-rooms.test.ts` |
| REQ-088 | `POST /rooms` honours `visibility: 'private'` | integration | `private-rooms.test.ts` |
| REQ-089 | POST `/rooms/:id/invitations` — auth / role / duplicate / banned / happy | integration | `invitations.test.ts` |
| REQ-089 | GET `/invitations` — inbox filter, join shape | integration | `invitations.test.ts` |
| REQ-089 | accept inserts `room_member` atomically, fires sockets | integration | `invitations.test.ts` |
| REQ-089 | decline flips status, fires socket, no member insert | integration | `invitations.test.ts` |
| REQ-089a | expired row invisible to inbox; does not block re-invite | integration | `invitations.test.ts` |
| REQ-088, REQ-089 | Alice/Bob two-browser happy path — invite → accept → enter → history | e2e | `tests/e2e/invitations.spec.ts` |
