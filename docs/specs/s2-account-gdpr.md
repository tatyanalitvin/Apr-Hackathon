# Spec: S2 — Account deletion + GDPR export

**Status**: shipped (2026-04-19)
**Branch**: `feat/s2-account-gdpr`
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code — S2 account/GDPR agent
**Scope**: v4 REQ-126 (GDPR data export), REQ-127 (export endpoint must be auth-gated). Related S1/S2 requirements reused: REQ-018 ("messages remain visible after account removal; username is replaced with a placeholder"), REQ-019 ("login rejected after account deletion"). The account-delete flow itself was previously an `Out of hackathon scope` item in FOLLOWUPS; S2 brings it in.

## 1. Why

The v3 brief §2.2 ("GDPR export") and the submission-gate checklist both require the user to be able to (a) download their own data on demand, and (b) remove their account with content preservation semantics (messages stay in rooms but attribution is stripped). Shipping this in S2 alongside DMs + friendship is the natural moment — the export has to walk all of those tables, so writing the traversal once with S2-fresh schema in mind beats retrofitting.

## 2. Non-goals

- **Email-based delete confirmation.** Password confirmation is enough for the hackathon. True email-token delete is out.
- **Re-register with the same email after delete.** Known collision on `UNIQUE(email)` — deferred to S3, documented in `docs/FOLLOWUPS.md`.
- **Attachment-byte cleanup on delete.** S3 orphan-GC job will extend to sweep messages authored by deleted users; bytes stay on disk for the hackathon.
- **Username change (REQ-127 legacy).** v3's REQ-127 was renumbered; our REQ-127 here is the export auth-gating test. Username change stays out (`docs/BRIEF.md`).

## 3. User stories

- As Alice, I can visit `/settings/account` and click "Download export" to get a JSON file with my profile, rooms, messages, DMs, friendships, and sessions. (REQ-126)
- As Alice, I can click "Delete my account", re-enter my password, and confirm — my profile is soft-deleted, my sessions are revoked, friendships/DM memberships are cleared, and the messages I sent stay in their rooms but render as `[deleted user]`. (REQ-018, REQ-019)
- As an unauthenticated visitor, if I try to POST the export endpoint I get a 401. (REQ-127)

## 4. Requirements (testable)

- [x] **REQ-126**: `POST /api/v1/users/me/export` returns a JSON attachment (Content-Type: application/json, Content-Disposition: attachment; filename=*.json) with seven top-level keys — `exportedAt`, `user`, `rooms`, `messages`, `directMessages`, `friendships`, `sessions` — populated from the caller's own data. Test: [apps/backend/tests/account-export.test.ts](../../apps/backend/tests/account-export.test.ts).
- [x] **REQ-127**: The export endpoint is auth-gated. Unauthenticated callers get 401; two authenticated callers only ever see their own data (no cross-user bleed). Test: [apps/backend/tests/account-export-auth.test.ts](../../apps/backend/tests/account-export-auth.test.ts).

## 5. Design notes

- **Data model**: no new tables. Reuses `user.deletedAt` (already in schema), hard-cascades `friendship`/`friend_request`/`user_block`/`room_member` on delete, leaves `message` rows intact. The denormalized `message.authorUsername`/`authorName` snapshots (Slack/Discord-style send-time copy) make the post-delete substitution purely a serialization concern.
- **API endpoints**:
  - `DELETE /api/v1/users/me` — body `{ password }`. Verifies current password via better-auth, then runs the cascade in a single transaction. Revokes sessions via `auth.api.revokeSessions`.
  - `POST /api/v1/users/me/export` — streams a `UserDataExport` JSON (see `packages/shared/src/protocol.ts`).
- **Substitution**: `apps/backend/src/lib/users.ts` exports `DELETED_USER_DISPLAY = "[deleted user]"`. Applied in `toMessagePayload` (group history) and in the DM list peer-map + lastMessage serializer.
- **Deleted-account login guard**: pre-auth wrapper on `/api/auth/sign-in/email` — if the user row exists with `deletedAt NOT NULL`, returns 403 before better-auth's password check runs.
- **UI**: new page `apps/web/src/app/settings/account/page.tsx` with Export + Delete sections; `apps/web/src/lib/account-api.ts` holds the `fetch` helpers.

## 6. Tasks

1. [x] Commit 1: `formatUserDisplay` helper in `lib/users.ts`
2. [x] Commit 2: `deleteAccountSchema` + `UserDataExport` DTO
3. [x] Commit 3 → 4: REQ-018 cascade test → `DELETE /api/v1/users/me` route
4. [x] Commit 5 → 6: REQ-019 login-rejected test → deleted-account guard
5. [x] Commit 7 → 8: REQ-126 export shape test → export route
6. [x] Commit 9: REQ-127 export auth-gated test
7. [x] Commit 10: `[deleted user]` substitution in history + DM list + DM lastMessage
8. [x] Commit 11: `/settings/account` UI + `account-api.ts`
9. [x] Commit 12: FOLLOWUPS deferrals (re-register email collision + attachment cleanup)

## 7. Out of scope / follow-ups

See `docs/FOLLOWUPS.md` → "S2 → S3 (account deletion + GDPR export)" for:

- Re-register-with-same-email collision (deferred — partial UNIQUE or tombstone pattern).
- Attachment-byte cleanup for messages authored by deleted users (folded into the S3 attachment orphan GC).

## 8. Open questions

- None open at ship time.
