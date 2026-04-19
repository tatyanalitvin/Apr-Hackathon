# Spec: S3 — Chat-surface polish batch

**Status**: draft (2026-04-20)
**Branch**: `feat/chat-surface-polish`
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code Opus 4.7
**Binding source**: v3 requirements docx §2.5.5, §2.6.2, §2.7.1, §4.4, §2.2.1, Appendix A.

## 1. Why

Four v3 spec clauses that had partial or missing implementations after wave 2 merged. Each is small on its own; bundled here because they share the same web surfaces (MessageList, MessageComposer, DmList, MemberList) and ship as one vertical.

## 2. Non-goals

- Message-edit by admin (v3 §2.5.5 grants delete only, not edit).
- Changes to the upload transport, size caps, or MIME policy — REQ-213 is UI affordance only.
- Changes to the `lastReadSeq` markRead endpoint contract — REQ-215 only computes from its existing state.
- Backend PresenceState protocol — REQ-214 reads from the already-broadcast `presence.changed` stream.

## 3. Test plan

Each REQ-ID is embedded verbatim in at least one test name.

- **REQ-212**: `apps/backend/tests/message-delete-admin.test.ts` (7 scenarios — owner/admin/member/DM/self/broadcast author/broadcast admin); `apps/web/src/components/chat/MessageList.test.tsx` (admin-delete gate variations); `apps/web/src/components/chat/MessageActions.test.tsx` (optional onEdit).
- **REQ-213**: `apps/web/src/components/chat/MessageComposer.test.tsx` — attach button renders when onUpload supplied, omits otherwise, forwards files, disables with composer.
- **REQ-214**: `apps/web/src/components/dm/DmList.test.tsx` — badge renders when count > 0, hides at 0; `apps/backend/tests/dms-unread-count.test.ts` — end-to-end unreadCount math vs head and last-read markers.
- **REQ-215**: `apps/web/src/components/chat/MemberList.test.tsx` — presence-state variations render the matching suffix or no suffix.

## 4. Requirements (testable)

- [x] **REQ-212** — v3 §2.5.5 admin delete. `DELETE /api/v1/rooms/:id/messages/:msgId` allows room owners/admins to soft-delete other members' messages in group rooms. DMs excluded (v3 §2.5.1). Broadcast payload carries `deletedByRole ∈ {author, admin}`. Frontend MessageActions reveals Delete on non-own messages when viewer role is owner/admin and `room.kind='group'`; Edit stays author-only.
- [x] **REQ-213** — v3 §2.6.2 paperclip affordance. MessageComposer renders an explicit "Attach files" button next to the emoji trigger when `onUpload` is supplied. Click routes through the same `uploadFiles()` path used by drag-drop and paste. Button disables with the rest of the composer (sending / disabled prop).
- [x] **REQ-214** — v3 §2.7.1 / §4.4 DM unread badges. `DmList` rows render `<UnreadBadge count={dm.unreadCount ?? 0} />` when count > 0. Backend `GET /api/v1/dms` computes `unreadCount = max(0, headSeq - lastReadSeq)` per DM room (replaces the `0` placeholder in routes/dms.ts).
- [x] **REQ-215** — v3 §2.2.1 / Appendix A presence suffix. `MemberList` appends a small "(AFK)" or "(offline)" text marker after the display name, sourced from the same `usePresence(userId)` hook that drives the pill. Online members show no suffix.

## 5. Design notes

### REQ-212 gate placement

Admin check runs BETWEEN the 404 (`target.roomId !== roomId`) and the idempotent re-delete path so a caller who is not a member — even an owner viewing via stale tab — 403s before we do any soft-delete write. DMs never enter the admin branch because `room.kind !== 'group'`. The broadcast payload stamps `deletedByRole='author'` for the self-delete path so clients can tell "I deleted mine" from "moderator deleted mine" without a secondary query.

### REQ-213 attachment UI

Hidden native `<input type="file" multiple>` is trampolined by the visible Paperclip. The `onChange` handler routes into the existing `uploadFiles(files)` path used by drop/paste so there is exactly one upload state machine. Input value is reset to empty string after each pick so selecting the same file twice still fires `change` (native input quirk).

### REQ-214 backend math

`dm.unreadCount = max(0, roomHeadSeq - lastReadSeq)` where `roomHeadSeq` is `messageSeq.seq` for the DM room and `lastReadSeq` is the caller's `roomMember.lastReadSeq` (same semantics as group rooms at apps/backend/src/routes/rooms.ts:251-293). The two selects fan out per DM room in the `/api/v1/dms` handler; at hackathon scale (N ≤ 50 DMs per user) that's fine — optimise with a JOIN or a grouped aggregate if load testing surfaces it.

### REQ-215 presence suffix

`MemberList` is the only consumer. `usePresence(userId)` is already exported from `PresencePill.tsx` — reuse it. Text marker goes beside the displayName inside the same flex row. Accessibility: the suffix is part of the visible text, no extra aria work needed.

## 6. Gate criteria

- [ ] `pnpm trace` picks up REQ-212..REQ-215 from tests (no ratchets).
- [ ] `pnpm --filter web typecheck` green.
- [ ] `pnpm --filter backend typecheck` green.
- [ ] `pnpm --filter web test:run` green.
- [ ] `pnpm --filter backend test:run tests/message-delete-admin.test.ts` green.
- [ ] `pnpm --filter backend test:run tests/dms-unread-count.test.ts` green (REQ-214 only).
- [ ] No edits to: `apps/backend/src/routes/rooms.ts`, `apps/backend/src/routes/invitations.ts`, room-related schemas in `packages/shared/src/dto.ts`, `apps/web/src/components/chat/CreateRoomDialog.tsx`, `apps/web/src/components/chat/manage-room/*`, `apps/web/src/app/rooms/browse/page.tsx`, `room.*` events in `packages/shared/src/protocol.ts`. RoomClient.tsx prop-pass exception noted and flagged.
