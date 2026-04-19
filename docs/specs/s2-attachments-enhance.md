# Spec: S2 — Attachments enhancement (comment + access-revoke)

**Status**: draft (2026-04-19)
**Branch**: `feat/attach-comment-revoke` (worktree: `../hackaton-attach-comment-revoke`)
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code — agent E (wave 2)
**Scope**: v3.docx §2.6.3 (per-upload optional comment in the UI) and §2.6.4 (losing room access = losing file access, including the uploader's own files). Extends the shipped `docs/specs/s2-attachments.md` without modifying any ADR-0006 deviation.

Depends on wave-1 **agent A** (moderation) — `room_ban` rows written by DELETE `/rooms/:id/members/:userId` and POST `/rooms/:id/bans`. This spec's revoke gate reads that table.

## 1. Why

Two unrelated §2.6 clauses that share a surface (`attachment` table + `/api/v1/attachments/:id`), cheap to ship together:

- **§2.6.3 comment**: The backend already persists and echoes `attachment.comment` (see `routes/attachments.ts:90` and `routes/messages.ts:165`), but there is no UI to enter the caption on upload or to display it next to the file on download. BRIEF.md demo step 4 showing Alice's "chart v2" caption under a shared image is impossible without this last-mile wiring.
- **§2.6.4 revoke**: The download gate currently checks `room_member` only ([routes/attachments.ts:203](../../apps/backend/src/routes/attachments.ts#L203)). After wave-1 agent A, kick writes a `room_ban` row **and** deletes the `room_member` row, so today's gate already 403s a kicked user incidentally. That's fragile: if a rejoin races with the cascade (or a future admin re-adds them without clearing the ban), the gate lets them through. §2.6.4 is a compliance claim, so the check must be an explicit `NOT EXISTS room_ban` gate, not an accident of the `room_member` delete.

The uploader-loses-access clause is the one that trips naive designs. Today's `routes/attachments.ts` already implements this correctly — the uploader's `room_member` row is gone after a kick, so they 403. This spec only formalises the invariant and adds a regression test that uses agent A's endpoint end-to-end (so a future optimisation that, e.g., keeps a "grandfather" row can't silently break it).

## 2. Non-goals

- Soft-delete of attachments on revoke (v4 REQ-084, deferred in ADR-0006 — uploader file stays on disk; only the download gate goes cold).
- "My uploads" uploader-retention view (v4 REQ-085, deferred; §2.6.5 explicitly says a kicked user "can no longer see, download, or manage" the file).
- Per-attachment comment editing after upload. Comment is write-once at upload time; the brief's §2.6.3 phrasing is "optional comment when uploading", not "editable caption".
- DM-specific gate logic. DM rooms already have two `room_member` rows; the room-member + room-ban gate covers them without a `kind='dm'` branch.
- Changing the existing 404-on-unknown-id behaviour. The "ban-oracle" concern is covered by 403-not-404 when the row *exists* but caller fails the gate (current + new behaviour). Unknown-id 404 is already an existing test (`REQ-083 unknown id → 404`) and was ratified by the s2-attachments spec.

## 3. Pre-existing state (no work)

So future reviewers can see what this spec touches vs. leaves alone:

- `packages/shared/src/schema.ts` attachment table already has `comment: text("comment")` at [schema.ts:373](../../packages/shared/src/schema.ts#L373). The column is also present in the initial migration `infra/migrations/0000_chilly_whirlwind.sql:31`. **Migration 0009 is therefore a dead file** — the drizzle `_journal.json` only tracks `0000`…`0008`, so the runner never opens `0009_attachment_comment.sql`. The pre-work placeholder stays as-is (3-line comment block). No risk of a duplicate-column ALTER because nothing will execute it; no need for `SELECT 1;` either.
- `routes/attachments.ts:90-98` reads the `comment` multipart field, NFC-normalises, and persists to the column. **Cap is 500 chars today** (§4 REQ-E-COMMENT-CAP below lowers it to 280).
- `routes/messages.ts` `loadAttachmentPayloads` already exposes `comment` in the message payload ([messages.ts:165](../../apps/backend/src/routes/messages.ts#L165)), so MessageList only needs to *render* it (no backend change for the display path).
- Upload response shape today is `{ attachmentId }` only; §4 REQ-E-UPLOAD-RESP extends it to include `comment` for symmetry.
- Web client already wires the comment partway: `UploadAttachmentInput.comment` at [chat-api.ts:21-25](../../apps/web/src/lib/chat-api.ts#L21-L25) and the multipart `append("comment", …)` at [chat-api.ts:300-303](../../apps/web/src/lib/chat-api.ts#L300-L303). What's missing: (a) `UploadAttachmentResult.comment` per REQ-E-UPLOAD-RESP, (b) MessageComposer state + input for the user to type it, (c) the `handleUpload` call site at [RoomClient.tsx:330](../../apps/web/src/app/rooms/[roomId]/RoomClient.tsx#L330) has to pass the comment into `uploadAttachment` — see §5.2 + **§10 blocker** on this one.

## 4. Requirements (REQ-IDs — pnpm trace)

- **REQ-E-COMMENT-CAP** (v3.docx §2.6.3): `attachment.comment` is capped at **280 UTF-16 code units** (i.e. JS `String.length`, the same unit the HTML `maxLength` attribute uses). Overflow → 400 `comment_too_long` before the file is persisted. Empty string normalises to NULL (today's handler already does this via `commentField.length > 0`). Reason the cap drops from the pre-existing 500: the brief calls 280 "client-side-friendly" and we want the UI `maxLength` attribute to match the backend byte-for-byte. Reason code-unit rather than code-point: avoids a `[...str].length` / `Intl.Segmenter` dependency and matches the HTML attribute exactly; a 280-emoji caption getting rejected at ~140 graphemes is an acceptable cost for that parity.
- **REQ-E-UPLOAD-RESP** (§2.6.3): the upload handler's 201 body includes `comment: string | null` so the client can reflect exactly what the server persisted (e.g., after NFC normalisation). No other response fields change.
- **REQ-E-REVOKE-GATE** (v3.docx §2.6.4): GET `/api/v1/attachments/:id` returns 403 when ANY of the following holds for caller `u` on the file's `roomId = r`:
  1. `u` has no `room_member` row for `r`; OR
  2. A `room_ban` row exists for `(r, u)`.
  Otherwise the existing stream path runs. 404 on unknown `:id` remains.
- **REQ-E-REVOKE-UPLOADER** (v3.docx §2.6.5): the uploader is subject to the same gate. After being kicked, `GET /api/v1/attachments/:own-file` → 403. No uploader grandfathering.
- **REQ-E-UI-COMPOSER-COMMENT** (§2.6.3): when `pending.length > 0` the composer renders a single batch-scoped input "Add a comment (optional)" (`maxLength=280`) inside the AGENT-E marker zone. On send, the composer forwards the comment via the existing `onUpload` callback — see §5 design for the callback-signature widening.
- **REQ-E-UI-LIST-COMMENT** (§2.6.3): when a rendered attachment has a non-null `comment`, MessageList shows it as a small italic line beneath the filename, visually truncated via CSS (`truncate` + `max-w-[18rem]`); full text exposed via `title=""` for hover. No JS length slicing — CSS is the single source of truth for the visible cutoff.

## 5. Design

### 5.1 Backend

**Comment cap.** `COMMENT_MAX` constant in `routes/attachments.ts` lowers from 500 to 280. Same 400 error shape (`{ error: "comment_too_long" }`). Measure `commentField.length` before NFC — string length post-normalisation can only shrink or stay equal for well-formed input, so capping before normalise keeps the error deterministic.

**Upload response.** Include the post-normalisation `comment: string | null` on the 201 body. Only additive; all existing supertest assertions that read `res.body.attachmentId` continue to pass.

**Download gate.** Single SQL change in the download handler: replace the lone `room_member` lookup with a `LEFT JOIN room_ban` (or a separate `NOT EXISTS` select). Implementation shape:

```ts
const [row] = await db
  .select({
    id: attachment.id,
    roomId: attachment.roomId,
    storagePath: attachment.storagePath,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    originalName: attachment.originalName,
    memberId: roomMember.id,
    banId: roomBan.id,
  })
  .from(attachment)
  .leftJoin(
    roomMember,
    and(eq(roomMember.roomId, attachment.roomId), eq(roomMember.userId, userId)),
  )
  .leftJoin(
    roomBan,
    and(eq(roomBan.roomId, attachment.roomId), eq(roomBan.userId, userId)),
  )
  .where(eq(attachment.id, request.params.id))
  .limit(1);
if (!row) return reply.status(404).send({ error: "not_found" });
if (!row.memberId || row.banId) return reply.status(403).send({ error: "forbidden" });
```

Single round-trip keeps the hot path close to the current pattern; no separate `room_ban` probe. `room_ban_room_user_uq` unique index covers the new join.

### 5.2 UI

**MessageComposer** (inside the AGENT-E marker only). Add a `comment: string` state initialised to `""`; render a text input bound to it with `maxLength={280}` when `pending.length > 0`. On successful send, clear `comment`. On room switch, clear with the existing `setPending([])` effect.

The composer currently exposes `onUpload?: (file: File) => Promise<{ attachmentId: string }>`. The comment is attached to the file at upload time (that's when the backend persists it). So the callback signature widens to:

```ts
onUpload?: (file: File, options?: { comment?: string }) => Promise<{ attachmentId: string; comment: string | null }>;
```

Backward compatible — callers that don't pass a comment get the current behaviour. `apps/web/src/lib/chat-api.ts` (or `attachments-api.ts` if it exists — client method lives wherever POST `/api/v1/attachments` is wired) updates to forward `comment` as a multipart field.

One-per-batch (not per-file) is simpler and matches the brief phrasing. When multiple files are pending, the same comment string is sent with each `onUpload()` invocation. Two files with identical captions is an acceptable demo cost; the alternative (per-file inputs) breaks the current `pending.map()` layout.

**MessageList** attachment-render block. Where each attachment currently shows `{originalName}` and the download link, add:

```tsx
{att.comment ? (
  <div
    className="text-xs italic text-muted-foreground truncate max-w-[18rem]"
    title={att.comment}
  >
    {att.comment}
  </div>
) : null}
```

CSS `truncate` (`text-overflow: ellipsis` + `overflow: hidden` + `white-space: nowrap`) handles the display cutoff responsively at the column width; the full comment is in the `title` tooltip. The 120-char number in §4 REQ-E-UI-LIST-COMMENT refers to the *visual* cap set by the 18rem `max-w`, which at typical text-xs sizing fits roughly that many mono-width code units. Dropping the JS slice keeps the `title` attribute intact (it would otherwise truncate the tooltip too) and avoids a second source of truth.

### 5.3 Migration 0009

Rewrite the placeholder from an `ALTER TABLE ADD COLUMN` to a no-op:

```sql
-- Wave-2 §2.6.3. The attachment.comment column was introduced in
-- 0000_chilly_whirlwind.sql (initial Drizzle snapshot), so this migration
-- is intentionally empty. Kept as a slot to preserve the sequential
-- numbering that the pre-work commit reserved.
SELECT 1;
```

`SELECT 1;` is a no-op that keeps drizzle-kit's migration runner happy (it records the hash so re-runs are idempotent). An empty file would be treated as a parse error by some migration runners, hence the sentinel statement.

## 6. Test plan (TDD)

New files (both allowed by file ownership):

- `apps/backend/tests/attachments-comment.test.ts`
  - **REQ-E-COMMENT-CAP** (positive): upload with `comment="see bottom of page 3"` → 201; GET message payload via `POST /api/v1/rooms/:id/messages` → message.attachments[0].comment equals the sent string (NFC-normalised).
  - **REQ-E-COMMENT-CAP** (overflow): upload with 281-char comment → 400 `comment_too_long`; row not inserted (DB `count(*)` unchanged).
  - **REQ-E-COMMENT-CAP** (empty): upload with `comment=""` → 201; stored value is NULL (SELECT `comment IS NULL`).
  - **REQ-E-UPLOAD-RESP**: 201 body contains `comment: string | null` matching persisted value.
  - **Persistence across reconnect**: after the upload, Alice's GET `/api/v1/rooms/:id/messages` returns the comment. (No actual socket reconnect — "reconnect" here means a fresh HTTP fetch of history.)

- `apps/backend/tests/attachments-revoke.test.ts`
  - **REQ-E-REVOKE-GATE, kick path** (non-cuttable): Alice owns room, Bob is member, Bob uploads F. Alice `DELETE /api/v1/rooms/:id/members/:bob` (agent A's endpoint — kick = insert room_ban + delete room_member). Bob `GET /api/v1/attachments/:F` → 403. Assert a `room_ban` row exists for `(room, bob)` — sanity that we're exercising A's code path. **Caveat**: this alone doesn't distinguish the old `room_member`-only gate from the new `room_member ∧ ¬room_ban` gate (both 403 via the missing member row). It's included because §2.6.5 explicitly calls out the kick flow and we want a 1:1 test for the brief. The NOT-EXISTS branch is exercised separately below.
  - **REQ-E-REVOKE-UPLOADER**: same scenario, Bob downloads **his own** file post-kick → 403. Same caveat re: member-row-absent — this primarily covers "uploader is not grandfathered".
  - **REQ-E-REVOKE-GATE, member + ban coexist** (**the load-bearing test for the new branch** — non-cuttable): exercises the exact fragility §1 motivates. Setup: Alice owner, Bob member, Bob uploads F. Directly INSERT a `room_ban` row for `(room, bob)` via the test-db helper, **leaving the `room_member` row intact** (simulates "admin re-added Bob without clearing the ban" or a future race between cascade and rejoin). Bob `GET /api/v1/attachments/:F` → 403. Against the OLD gate (member-only) this test would return 200 — so it's a true regression guard on the new branch.
  - **REQ-E-REVOKE-GATE, POST /bans path**: Alice POST `/api/v1/rooms/:id/bans` with Bob (who was a member and uploader). Per [rooms.ts:928-948](../../apps/backend/src/routes/rooms.ts#L928-L948), the handler writes the ban row AND deletes the member row atomically; post-request Bob has a ban row only. Bob → 403. Same "both gates would pass" caveat as the kick path — but combined with the previous test, we have full coverage of the conjunction.
  - **Remaining member unaffected**: a second non-banned member Carol downloads F → 200 (regression guard — don't over-tighten).

- UI tests deferred to manual smoke (per `feedback-batched-smoke`): dual-browser Alice+Bob flow covered in the gate-criteria checklist.

Vitest-one-buildApp discipline: each new test file calls `buildApp()` exactly once in a top-level `beforeAll`; all `describe` blocks share it.

## 7. Gate criteria

- `pnpm --filter backend test:run` green for `attachments-comment.test.ts` and `attachments-revoke.test.ts` in isolation. Full suite may have pre-existing shared-DB flakes per FOLLOWUPS — re-run the two new files alone if a global re-run is noisy.
- `pnpm --filter web typecheck` green (TextField import + composer prop widening + MessageList comment render).
- `pnpm trace` reports zero orphan REQ-IDs for `REQ-E-*`.
- Manual dual-browser smoke deferred to FOLLOWUPS per `feedback-batched-smoke`: Alice uploads with caption "chart v2" → Bob sees caption under filename; Alice kicks Bob → Bob's link 403s; Bob unbanned + rejoins → link returns 200.

## 8. Kill-switch (ordered)

From the brief, repeated here so a reviewer can see the cut queue without leaving the spec:

1. Per-attachment comment → one-per-batch (already the chosen default).
2. 280-char cap → accept any length; DB column is `text`. **Note**: cutting the cap also means dropping the "empty string → NULL" coercion is still intact (the `commentField.length > 0` branch), and the 400 overflow response goes away entirely. Don't leave the cap at 280 on the client but unchecked on the server — that's silent client-side-only enforcement and a rejected submit from a manual curl would be undefined.
3. DM-participant branch refinement → defer (the existing room-member gate covers DMs).

Non-cuttable: the **member + ban coexist** revoke test (proves the new NOT-EXISTS branch) and the kick/POST-`/bans` revoke tests (prove the wave-1 moderation table is the source of truth for the wave-2 gate). Together they cover both "the gate fires on ban alone" and "real-world kick flows 403 correctly".

## 9. Open questions for human

1. **Response shape additive**: adding `comment` to the upload 201 body is cheap and matches the brief ("Response shape adds comment on the returned attachment metadata"). No existing test reads extra fields strictly, so additive is safe. OK to proceed.
2. **280 vs 500 cap**: the brief's 280 supersedes `s2-attachments.md` §REQ-082's 500. Going with 280 per brief; flagged here so s2-attachments.md §REQ-082 can be updated by a trailing doc commit if you want alignment. If you'd rather keep 500, tell me before I write the failing test — it's the spec.

## 10. File-ownership blocker

[RoomClient.tsx:330](../../apps/web/src/app/rooms/[roomId]/RoomClient.tsx#L330) is the one caller of `apiRef.current.uploadAttachment({ roomId, file })`. The composer's `onUpload` prop points at `handleUpload` at [RoomClient.tsx:553](../../apps/web/src/app/rooms/[roomId]/RoomClient.tsx#L553). To carry a `comment` from the composer's state into `chat-api.uploadAttachment`, the `onUpload` signature has to widen and `handleUpload` has to forward the options — that's a ≤3-line edit inside `RoomClient.tsx`.

**`RoomClient.tsx` is not in my file-ownership list** (brief §File ownership). Per the brief's "Stop and flag if any file outside the ownership list needs to change", I need your OK before proceeding. Three options:

1. **(preferred)** Approve the narrow edit: widen `onUpload?: (file, options?: { comment?: string }) => Promise<…>`; update the one-liner `handleUpload` to spread options into `uploadAttachment`. Targeted, reviewable diff, no reply-chip / emoji / textarea collateral. This is what §5.2 assumes.
2. **Side-channel via a new prop**: give the composer an `onUploadWithComment` prop, or expose comment through a ref the parent reads on submit. Both are uglier than option 1 because the upload-to-multipart plumbing is still in RoomClient and still needs updating — the blocker moves, it doesn't go away.
3. **Composer imports chat-api directly**: bypass `onUpload`, call `uploadAttachment` from the composer. Breaks the component's abstraction (composer currently knows nothing about BACKEND_URL, fetch, or DTOs) and creates a second upload code path. Not recommended.

If option 1 is rejected, REQ-E-UI-COMPOSER-COMMENT gets cut (the UI can't carry the comment at all; manual curl still works). Backend work (cap, NOT-EXISTS gate, tests) is unaffected and still ships.
