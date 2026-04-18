# Spec: S2 — Attachments (local-FS uploads, 2-step upload→send flow)

**Status**: draft (2026-04-18)
**Branch**: `feat/s2-attachments` (worktree to be created off `main` after S1 + `feat/s2-dms` merge)
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code — S2 attachments agent (pairs with `s2-dms.md` for DM parity)
**Scope**: v4 REQ-075 (supported types), REQ-077 (size limits), REQ-078 (download-always-attachment), REQ-079 (upload methods), REQ-081 (filename handling), REQ-082 (optional comment), REQ-083 (download authorization). v4 REQ-076 (SVG sanitization), REQ-080 (progress/cancel UI), REQ-084 (soft-delete + 7-day GC), REQ-085 (uploader-retention of own-uploads view) are deferred / deviate — see `### ADR-0006 deviations` in §7. Depends on `s2-dms.md` for the freeze predicate that gates DM attachment sends.

**REQ-ID assignment vs. v4 catalog** (alignment table; deviations all fold into ADR-0006):

| ID | v4 meaning | How S2 implements it |
| --- | --- | --- |
| REQ-075 | Supported types + executable deny-list | S2 accepts arbitrary MIME types; v4's magic-byte deny-list is deferred to S3 — see ADR-0006 |
| REQ-076 | SVG sanitization + CSP sandbox | Deferred to S3 — see ADR-0006 |
| REQ-077 | Size limits 25 MB file / 5 MB image | S2 caps at 20 MB / 3 MB per v3.docx + BRIEF.md — see ADR-0006 |
| REQ-078 | Downloads always `Content-Disposition: attachment` | Implemented verbatim on the download handler (R11) |
| REQ-079 | Upload methods: button + paste + drag-drop (multi-file up to 10) | S2 supports all three methods but caps at **one file per request** (client loops for multi-upload) — see ADR-0006 |
| REQ-080 | Per-file upload progress + cancel | Deferred — spinner-only UX, no progress events — see ADR-0006 |
| REQ-081 | `display_name` preserved + sanitized ASCII storage path | Implemented via two columns: `originalName` (display) + `storagePath` (on-disk UUID path) |
| REQ-082 | Optional comment up to 500 bytes UTF-8 NFC | Implemented as `attachment.comment` with 500-char cap |
| REQ-083 | Per-request membership auth on `GET /files/:id` | Implemented as recomputed membership check on every download (R6, R11) |
| REQ-084 | Soft-delete + 7-day GC on room deletion | S2 uses FK cascade hard-delete; the 7-day retention / GC job is deferred to S3 — see ADR-0006 |
| REQ-085 | Uploader retains `/uploads/mine` view after losing room access | S2 revokes uploader access entirely; remaining-member access half still holds — see ADR-0006 |

## 1. Why

BRIEF.md demo step 4 is "alice uploads a photo via drag-drop; bob sees it inline". No attachments → no demo "wow"; the chat server looks like a plain-text teletype. Attachments are also the only v3.docx §3.4 feature that requires touching the filesystem — every other S1/S2 surface is REST+DB+Socket.IO — so they're the highest-risk slice for the `docker compose up` submission gate: the `uploads` volume must survive restart AND the bind mount must work on a fresh clone without `infra/uploads/` being in the git tree (it's gitignored; the `.gitkeep` ensures the path exists).

The schema already anticipates this feature. [packages/shared/src/schema.ts:313](../../packages/shared/src/schema.ts#L313) defines the `attachment` table with `messageId` nullable-on-purpose — the 2-step "upload first, then send message with references" flow is already baked in (see the `TODO(S3-GC)` at [schema.ts:318](../../packages/shared/src/schema.ts#L318)). [packages/shared/src/dto.ts:42](../../packages/shared/src/dto.ts#L42) already accepts `attachmentIds` on `sendMessageSchema` and the S1 handler ignores it. This spec wires the two ends: a new upload endpoint that writes the file + inserts the attachment row with `messageId=NULL`, and a link step inside the existing `POST /api/v1/rooms/:id/messages` handler that sets `messageId` when `attachmentIds` is non-empty.

Correctness is load-bearing because v3.docx §2.6.4 / §3.6 promise that **losing access to a room loses access to its files**. That invariant has to hold for every delivery path — both the live download endpoint and the inline-render URL the browser hits for images. If a former member can still `GET /api/v1/attachments/:id` via a leaked URL, we fail the compliance claim even if the UI hides the thumbnail. §5 below places the access check on every byte served, not once at link-time.

## 2. Non-goals

Explicit, so reviewers don't flag:

- **Cloud storage (S3, Supabase Storage, Cloudflare R2, etc.)** — v3.docx §3.4 is unambiguous: "Files shall be stored on the local file system." The `UPLOAD_DIR` env var + the `uploads` docker volume ([docker-compose.yml:63](../../docker-compose.yml#L63)) are the storage layer. No signed URLs, no external object store, no CDN.
- **Thumbnailing, image resizing, EXIF scrubbing, virus scanning** — not in v3.docx, not in BRIEF.md. Images render via the browser's native `<img>` tag from the raw download URL. If a judge uploads a 2.9 MB 6000×6000 JPEG, the browser lays out a 6000-px image; that's the judge's problem, not a bug.
- **Progress UI / resumable uploads** — single-request `multipart/form-data`. 20 MB at 100 Mbps fits in ~2 s; resumability is not worth the complexity. Frontend shows a spinner; failure → retry the whole upload.
- **Arbitrary file type restrictions (deny `.exe`, `.bat`, etc.)** — v3.docx §2.6.1 says "arbitrary file types". No allowlist, no denylist. Downloads serve with `Content-Disposition: attachment` (see §5) so the browser never auto-executes.
- **Orphan-file GC** — the TODO at [schema.ts:318](../../packages/shared/src/schema.ts#L318) and [docs/FOLLOWUPS.md](../FOLLOWUPS.md) defer the sweep of `messageId IS NULL` rows older than 1h to S3 hardening. This spec leaves orphans to accumulate; at 300 concurrent users for 24h the footprint is negligible.
- **Inline rendering beyond `<img>`** — no PDF preview, no video playback UI, no audio scrubber. Non-image attachments render as a filename chip with a download button. The UI surface is owned by `s2-web.md`; this spec only promises the backend serves bytes with the right headers.
- **Edit/delete of attachments** — S2 `s2-edit-delete.md` (REQ-110..REQ-114) owns message edit/delete. Deleting a message cascades to its attachments via `onDelete: cascade` on `attachment.messageId` ([schema.ts:320](../../packages/shared/src/schema.ts#L320)) — the DB row disappears, but this spec's job is the CONTRACT that the file on disk also goes. Deferred to that spec; see §7 follow-ups.
- **Comment/caption editing after send** — §2.6.3 lets the uploader set a comment on upload. Changing it post-send is not in scope; would piggyback on edit-message.
- **Per-attachment ACLs beyond room membership** — room members can download all attachments in their rooms. No "hide this file from carol even though she's a member" feature. DMs follow the same rule, gated by the 2-member room check.

## 3. User stories

- As Alice (authenticated room member), I drag an image into the `general` room's composer; the browser POSTs to `/api/v1/attachments` with `multipart/form-data`; the server stores the bytes under `UPLOAD_DIR`, inserts an `attachment` row with `messageId=NULL`, and returns `{ attachmentId }`. The image does not appear in the room yet. (v4 REQ-075, REQ-079)
- As Alice, I then `POST /api/v1/rooms/general/messages` with `{ body: "", attachmentIds: [attachmentId] }`; the send handler UPDATEs the attachment row's `messageId` inside the same transaction as the message insert, and the `message.new` broadcast carries the attachment metadata inline. Bob's browser renders the image inline using the download URL. (transverse link step; inline-metadata shape is protocol-internal)
- As Alice, the server returns 413 if my upload exceeds 20 MB (any file) or 3 MB (images detected by `mimeType`). (v4 REQ-077; numeric caps deviate from v4's 25 MB / 5 MB — see ADR-0006)
- As Alice, I can paste a screenshot into the composer (browser's `ClipboardEvent.clipboardData.files`); the web client hits the same `POST /api/v1/attachments` endpoint. (v4 REQ-079 paste path)
- As Alice, the uploaded file's original name ("vacation-photo.jpeg") is preserved and shown to bob; when bob downloads, `Content-Disposition: attachment; filename="vacation-photo.jpeg"` names the saved file. (v4 REQ-078, REQ-081)
- As Alice, I can add an optional caption on upload (form field `comment`); bob sees the caption under the attachment. (v4 REQ-082)
- As Carol (NOT a member of `general`), if I try to `GET /api/v1/attachments/:id` I get 403, whether or not the file is referenced by a message. (v4 REQ-083)
- As Alice, if I'm kicked from `general` or the room is deleted, I can no longer download any attachments from it — even ones I uploaded myself. (deviation: v4 REQ-085 says uploader retains access via `/uploads/mine`; S2 does not implement that view — see ADR-0006)
- As Alice, attachments I uploaded survive me losing access to the room — the file bytes stay on disk, someone who still has access can still download. (v4 REQ-085 remaining-member half)
- As Alice, I can send attachments in a DM the same way as a group room. The freeze predicate from `s2-dms.md` gates the LINK step: a frozen DM rejects the message send, so the attachment stays orphaned (later GC'd in S3). (transverse DM parity — cross-ref `s2-dms.md` R5)
- As Bob subscribing to a room, every `message.new` event and every history slice entry carries `attachments: AttachmentPayload[]` inline, so my renderer has filename + mimeType + sizeBytes + downloadUrl without a second round-trip. (transverse wire-format)
- As the demo operator, `docker compose up --build` + `pnpm db:seed` does NOT pre-populate attachments; the demo starts with empty `UPLOAD_DIR` and alice creates the first upload live. (operational)

## 4. Requirements (testable)

`pnpm trace` greps `tests/` for each REQ-ID; test names MUST embed them verbatim.

- [ ] **R1 (REQ-075 supported types)**: `POST /api/v1/attachments` accepts any `multipart/form-data` file regardless of extension or `Content-Type`. Images (mimeType matching `^image/`) trigger the stricter 3 MB cap (R8). All other types fall under the 20 MB cap (R7). Tests: upload a 1 KB `.txt`, a 1 KB `.png`, a 1 KB `.exe`-named file — all 201; mimeType stored matches the `Content-Type` header from the multipart part (no server-side sniffing in S2 — flagged in §8 Q2). v4 REQ-075 also mandates a magic-byte executable deny-list; S2 does not enforce it — see ADR-0006.
- [ ] **R2 (REQ-079 upload endpoint shape, REQ-082 comment field)**: Endpoint accepts a single file per request. Multiple files → use multiple requests (client-side; v4 REQ-079 specifies up to 10 files per message — multi-file batching is deferred, see ADR-0006). Smoke test: field name `file`; form field `roomId` (required) identifies the target room; form field `comment` (optional, ≤500 chars per R4) carries the caption. Missing `file` → 400; missing `roomId` → 400; `comment` >500 chars → 400.
- [ ] **R3 (REQ-079 paste/drag/button parity)**: The web client hits the same endpoint for paste, drag-drop, and button-click uploads. The backend has no way to distinguish the three, so there's no paste-specific test — just a contract note in §5 that the frontend routes all three through one code path. Frontend concern owned by `s2-web.md`; no backend test here beyond R2.
- [ ] **R4 (REQ-081 original filename + REQ-082 comment — preserved verbatim for display)**: Upload persists `originalName` VERBATIM from the multipart part's `filename` ([schema.ts:328](../../packages/shared/src/schema.ts#L328)), modulo NFC-normalization (same pipeline as message body per REQ-031). **Unsafe characters are NOT stripped from `originalName`** — this is the display column. The on-disk path sanitization in R10 is a SEPARATE column (`storagePath`), computed from the random UUID + a sanitized extension. So `originalName="../../etc/passwd"` round-trips as-is in the DB and in `Content-Disposition`; the on-disk file lives at a safe path. Optional `comment` stored in `attachment.comment` ([schema.ts:334](../../packages/shared/src/schema.ts#L334)). Download (R11) serves with `Content-Disposition: attachment; filename*=UTF-8''<percent-encoded>` to survive unicode (`RFC 5987`). Test: upload a file named `"файл.txt"`, assert stored `originalName === "файл.txt"`, assert download's Content-Disposition parses to that exact filename.
- [ ] **R5 (transverse upload-side auth)**: `POST /api/v1/attachments` requires the caller be a member of `roomId`. Extends the S1-landed `requireRoomMember` helper ([apps/backend/src/lib/message-auth.ts](../../apps/backend/src/lib/message-auth.ts)). Non-member → 403 `not_a_member`. Unauth → 401. Tests: four branches — unauth, auth-but-not-member, auth+member-group, auth+member-dm. (v4 REQ-083 names the analogous download check; upload-side is the same principle.)
- [ ] **R6 (REQ-083 membership check on download)**: `GET /api/v1/attachments/:id` requires the caller be a *current* member of the attachment's `roomId`. Membership is checked per-request — NO signed URL, NO cached grant. Former member → 403, even if they uploaded the file themselves (see R14 / ADR-0006 for the deviation from v4's `/uploads/mine` retention view). Test: alice uploads, alice is removed from the room, alice's GET returns 403.
- [ ] **R7 (REQ-077 file size cap — S2 value 20 MB)**: Any upload exceeding `20 * 1024 * 1024` bytes → 413 `file_too_large`. Enforced at the Fastify multipart plugin level (`fileSize` option) so we never buffer the overage. Test: 20_971_521 bytes → 413; 20_971_520 bytes → 201. Boundary test is the only test that matters. v4 REQ-077 specifies 25 MB; S2 retains v3.docx's 20 MB — see ADR-0006.
- [ ] **R8 (REQ-077 image size cap — S2 value 3 MB)**: When the multipart part's `Content-Type` matches `^image/`, the cap is `3 * 1024 * 1024` bytes. Implementation: the Fastify plugin is configured with `fileSize: 20 MB` (the outer cap); the handler checks `mimeType.startsWith("image/") && size > 3 MB` after the write starts but before commit. If exceeded → delete the partial file, return 413 `image_too_large`. Test: 3_145_729 B as `image/png` → 413; 3_145_728 B as `image/png` → 201; 4 MB as `application/octet-stream` → 201 (not an image, 20 MB cap applies). **Alternative** (§8 Q3): reject based on `Content-Length` header if present, before any bytes are buffered — faster rejection at the cost of trusting a client header. v4 REQ-077 specifies 5 MB image cap; S2 retains v3.docx's 3 MB — see ADR-0006.
- [ ] **R9 (transverse storage layout)**: Files land under `UPLOAD_DIR` (env var; dev `./infra/uploads`, prod `/data/uploads` per [docker-compose.yml:60](../../docker-compose.yml#L60)). Path: `${UPLOAD_DIR}/${yyyy}/${mm}/${attachmentId}${ext}` where `yyyy`/`mm` come from the upload timestamp and `ext` is the original file's extension preserved as-is (or empty). `attachment.storagePath` stores the RELATIVE path (`"2026/04/<attId>.png"`) so the column survives UPLOAD_DIR changes. Test: upload a file, assert the file exists at `UPLOAD_DIR + storagePath`, assert `storagePath` does NOT start with `/`. (Local-FS choice comes from v3.docx §3.4 + BRIEF.md — no direct v4 REQ.)
- [ ] **R10 (REQ-081 path sanitization — separate column from R4 display)**: `attachmentId` is a generated `crypto.randomUUID()` (not user-derived). `originalName` is NEVER used in the on-disk path — it lives in the DB row (R4) and in the download's `Content-Disposition`, nothing else. On-disk path is computed purely from `attachmentId` + sanitized extension. The two columns (`originalName` display, `storagePath` on-disk) exist precisely to avoid the "sanitize for safety vs preserve for UX" collision. Test: upload with `originalName="../../../etc/passwd"`, assert the file is written under `UPLOAD_DIR/<yyyy>/<mm>/<uuid><ext>` where `<ext>` is sanitized to `[a-zA-Z0-9]{0,8}` (longer or non-alphanumeric → empty). Assert no file was created outside `UPLOAD_DIR`.
- [ ] **R11 (REQ-078 Content-Disposition + REQ-083 membership on download)**: `GET /api/v1/attachments/:id` streams the file with `Content-Type: ${attachment.mimeType}`, `Content-Length: ${attachment.sizeBytes}`, `Content-Disposition: attachment; filename*=UTF-8''<encoded>` (R4). No `X-Content-Type-Options: nosniff` header adjustment needed — S3 CSP spec owns that. The stream uses `fs.createReadStream` + `reply.send(stream)`; no full-buffer read. If the file on disk is missing (operator error) → 500 `storage_gone`. Membership recomputed on every request (R6). Inline image preview endpoint (v4 REQ-078's `Content-Disposition: inline` + CSP sandbox branch) is deferred — see ADR-0006.
- [ ] **R12 (transverse link step on message send)**: `POST /api/v1/rooms/:id/messages` with `attachmentIds: [a, b, c]` MUST, inside the same transaction as the `message` INSERT + seq allocation: (a) SELECT the rows `WHERE id IN (…) AND uploader_id = :caller AND room_id = :targetRoomId AND message_id IS NULL FOR UPDATE`, (b) UPDATE SET `message_id = :newMsgId`. Input cap is `.max(10)` from the existing zod schema ([packages/shared/src/dto.ts:42](../../packages/shared/src/dto.ts#L42)) — over-10 returns 400 at the validation layer, before the transaction opens. If any row is missing from the SELECT → 400 `attachment_invalid` with NO message inserted (transaction rolls back, seq NOT advanced). **Rollback leaves the attachment row's `messageId` NULL on disk AND in the DB** — that IS the orphan state; S3 GC sweeps it. Files are NOT unlinked on link-step rollback (the upload succeeded, the linking failed; the user may retry the send referencing the same `attachmentId`). Tests: four branches — (a) happy path, 3 attachments link, (b) attachment owned by bob → 400, (c) attachment uploaded to a different room → 400, (d) attachment already linked (messageId not null) → 400. (2-step upload→link flow is a design choice; no direct v4 REQ.)
- [ ] **R13 (transverse DM parity)**: Sending an attachment-bearing message to a DM room uses the same handler. The S1 send handler, once extended per `s2-dms.md` R5, invokes `apps/backend/src/lib/dm-freeze.ts` as one of its first checks (before seq allocation, before the R12 link step). If frozen → 409 `dialog_frozen` with NO message, NO seq consumed, and the attachment row stays `messageId=NULL` (orphan, GC'd in S3). Upload itself (R1) does NOT check freeze — freeze gates writes to the conversation, not the scratch-pad upload (see §8 Q6 for the trade-off). **Inherited open question**: `s2-dms.md` Q6 (freeze-on-soft-deleted-counterpart) silently gates R13 too — if that Q resolves to option (b) (predicate extended in-spec), the same extension covers attachment sends because they share the helper. If it resolves to option (a) (REQ-125 spec owns the friendship hard-delete), R13 is unaffected. Cross-ref in §8 Q7. Test: freeze an alice-bob DM; alice uploads → 201; alice sends-with-attachment → 409; assert attachment row still has `messageId IS NULL`.
- [ ] **R14 (transverse — uploader-retention deviation)**: Alice uploads, sends (attachment linked to a message), then alice is removed from the room (the remove-from-room endpoint is owned by `s2-rooms.md`; test uses direct DB delete of `room_member` row as a stand-in — contract item cited). Bob (still a member) can still GET the attachment. Alice can NOT (R6). File on disk still exists. Test: after removal, assert `fs.existsSync(path.join(env.UPLOAD_DIR, storagePath))` is true AND bob's GET returns 200 AND alice's GET returns 403. Note: `storagePath` is stored relative (R9); always compose via `path.join(env.UPLOAD_DIR, storagePath)` — never string-concat — so Windows dev and Unix prod behave the same. The v4 catalog additionally requires that the removed uploader retain access to their own uploads via `/uploads/mine`; S2 does not ship that view — see ADR-0006.
- [ ] **R15 (transverse — cascade on room delete, deviates from v4 retention semantics)**: When a `room` row is hard-deleted, `attachment.roomId` FK ([schema.ts:321](../../packages/shared/src/schema.ts#L321)) uses `onDelete: cascade` → rows vanish. BUT the files on disk do NOT vanish automatically. The room-delete spec (`s2-rooms.md`, owner transfer + delete endpoints) owns the "delete files on disk" step — contract item documented in §7. This spec asserts the DB cascade fires (the row is gone) but XFAILs "the file on disk is gone" with a comment citing the other spec. v4 mandates soft-delete + 7-day GC retention window for undo; S2 hard-deletes immediately — see ADR-0006.
- [ ] **R16 (transverse)**: `POST /api/v1/attachments` and `GET /api/v1/attachments/:id` reuse the better-auth session helper (`toFetchHeaders` + `getSession`). Missing session → 401. One test per endpoint.
- [ ] **R17 (transverse wire-format)**: The `MessagePayload` type on the wire ([packages/shared/src/protocol.ts:18](../../packages/shared/src/protocol.ts#L18)) gains an optional `attachments: AttachmentPayload[]` field — protocol addition flagged in §8 Q1. `AttachmentPayload` = `{ id, originalName, mimeType, sizeBytes, comment: string | null, downloadUrl: string }`. `downloadUrl` is `/api/v1/attachments/:id` — a RELATIVE URL the client prefixes with `NEXT_PUBLIC_BACKEND_URL`. Tests: after R12 links 3 attachments, `GET /rooms/:id/messages` and the `message.new` socket event both carry the 3 `AttachmentPayload`s in order. (No direct v4 REQ; protocol-internal.)
- [ ] **R18 (transverse disk-full / unlink-best-effort)**: If `fs.createWriteStream` fails (ENOSPC, EROFS, permission denied) mid-upload, the handler aborts the stream, returns 500 `storage_unavailable`, and attempts `fs.unlink` of whatever was partially written (best-effort; a failed unlink is logged, not retried — we're already returning 500). No DB row is inserted if the write didn't finish — attachment row INSERT happens AFTER `close` fires, so the caller sees a clean "nothing happened" failure with nothing to clean up DB-side. For the R8 image-cap abort, the same best-effort unlink path applies. Test skipped in CI (hard to fake ENOSPC portably); documented as manual verification. Flagged as a gap if an agent wonders "what happens when the disk fills up during demo".

## 5. Design notes

### Data model

**No new tables; one schema delta candidate (flagged §8 Q5)**:

The existing `attachment` table at [schema.ts:313](../../packages/shared/src/schema.ts#L313) covers everything: `messageId` (nullable for the 2-step flow), `roomId` (FK for the cascade + membership check), `uploaderId`, `originalName`, `storagePath`, `mimeType`, `sizeBytes`, `comment`, `createdAt`. No changes required for the happy path.

**Open candidate**: add `attachment.deletedAt timestamp` + soft-delete on cascade. Default design is hard-delete-on-cascade (simpler, no GC debt). Q5 asks whether a soft-delete is worth it; recommendation is no for S2.

### REST surface

Two new routes in `apps/backend/src/routes/attachments.ts`, registered under `/api/v1` alongside the existing `messagesRoutes`.

| Route | REQ | Purpose | Body / query | Response |
| --- | --- | --- | --- | --- |
| `POST /api/v1/attachments` | REQ-075, REQ-076, REQ-081, REQ-082 | Upload a single file, create an orphan attachment row (`messageId=NULL`) | `multipart/form-data`: `file` (required), `roomId` (required), `comment` (optional, ≤500) | 201 `{ attachmentId }` \| 400 \| 401 \| 403 \| 413 |
| `GET /api/v1/attachments/:id` | REQ-078, REQ-079 | Download stream, access-controlled | — | 200 file stream \| 401 \| 403 \| 404 \| 500 `storage_gone` |

**The link step lives inside the existing `POST /api/v1/rooms/:id/messages`** — not a new route. The S1 handler is extended (single `if (attachmentIds?.length > 0)` branch inside the transaction) per R12. No shape change to the endpoint's 201 response beyond the `MessagePayload.attachments` addition (Q1).

### Multipart parsing

Use `@fastify/multipart` (already in the Fastify ecosystem; verify via Context7 before the implementation PR). Config:

```ts
await app.register(multipart, {
  limits: {
    fileSize: 20 * 1024 * 1024,   // 20 MB outer cap (REQ-081)
    files: 1,                      // one file per request (R2)
    fields: 4,                     // file + roomId + comment + csrf (S3 adds csrf)
    fieldSize: 600,                // comment ≤500 + a margin
  },
});
```

The image-cap check (R8) happens in handler code after mime is known. If the stream exceeds the image cap mid-write, we abort + `fs.unlink` the partial file before returning 413 — failure to unlink is logged, not retried (orphan file GC owns cleanup in S3).

### Storage layout

Path pattern (R9): `${UPLOAD_DIR}/${yyyy}/${mm}/${attachmentId}${ext}`. Example: `/data/uploads/2026/04/1f3d…-8e2a.png`.

`attachmentId` is `crypto.randomUUID()` — not derived from user input. Sub-directories bucketed by year/month keep any single directory under ~10k entries at the spec's concurrency (R9 helps `ls` stay fast; not a scale win at 24h hackathon volume, but costs nothing to implement right).

`ext`: extracted from `originalName` as `path.extname(originalName)`. Sanitized to `[a-zA-Z0-9]{0,8}` — longer or weirder extensions become empty (R10). The extension is cosmetic (for `file` command on the server) — downloads use `attachment.mimeType`, not the file extension.

`UPLOAD_DIR` is read from env at boot ([apps/backend/src/env.ts](../../apps/backend/src/env.ts)). The dev default is `./infra/uploads`; prod (docker) is `/data/uploads` via the `uploads` volume. Handler `mkdir -p`s the `yyyy/mm` sub-directory on each upload (cheap; `recursive: true` is idempotent).

### Access control placement

Every download recomputes membership — see R6, R11. The check is one query: `SELECT 1 FROM room_member WHERE user_id=:caller AND room_id=:attachment.roomId`. For DMs, the same query works (DMs are rooms with `kind='dm'`, two members; `s2-dms.md` R3). If the room is soft-deleted (hypothetical — rooms aren't soft-deleted in current schema, it's hard-delete per REQ-087), the row wouldn't exist anyway.

**No signed URLs.** A download URL is just `/api/v1/attachments/:id`; the browser includes the better-auth session cookie automatically. An image rendered via `<img src="/api/v1/attachments/:id">` hits the same handler with the same membership check. S3 hardening spec (`s3-security.md`, REQ-151) will add signed URLs on top; this spec's contract is "every byte served is behind a membership check", which survives the S3 upgrade without reshaping the handler.

### Link step transaction (R12)

Already the S1 message-send handler opens a transaction for seq allocation + message insert (see `apps/backend/src/lib/seq-allocator.ts`). The link step is two extra statements inside the same transaction:

```sql
-- (a) reserve
SELECT id FROM attachment
  WHERE id = ANY(:ids)
    AND uploader_id = :caller
    AND room_id = :room
    AND message_id IS NULL
  FOR UPDATE;
-- if returned rows < input array length → throw 400 attachment_invalid (rolls back)
-- (b) link
UPDATE attachment SET message_id = :newMsgId WHERE id = ANY(:ids);
```

`FOR UPDATE` prevents a race where the same attachment is linked to two messages. Without it, two concurrent sends could both pass the SELECT and both UPDATE; the second UPDATE would stomp the first but both messages would appear with the same attachmentId. Unlikely in practice (client-side), but cheap to prevent.

### Socket.IO surface

**No new events.** `message.new` carries `MessagePayload`, and Q1 extends `MessagePayload` with `attachments`. DMs fan out via the same event (see `s2-dms.md` R8).

No upload-progress events, no `attachment.uploaded` event. The `POST /api/v1/attachments` response IS the progress notification (2 states: success or failure).

### Wire format additions

`packages/shared/src/protocol.ts` — new interface `AttachmentPayload`; extend `MessagePayload.attachments?: AttachmentPayload[]` (Q1). `packages/shared/src/dto.ts` — `attachmentIds` already exists; no change. Upload request body is raw multipart; no zod schema for the request (multipart parts are parsed by `@fastify/multipart`, not zod). Upload RESPONSE is small enough to inline `{ attachmentId: z.string() }` in the handler.

### Size enforcement — where and why twice

REQ-081 (20 MB) and REQ-082 (3 MB) overlap. The multipart plugin enforces 20 MB at the byte stream level — the request is terminated with 413 before any handler code runs if the client tries 30 MB. The 3 MB image cap is a smaller, conditional check that the handler does in-process. Doing BOTH at the handler level would mean buffering 30 MB of adversarial upload before rejecting — that's what the plugin prevents. Doing BOTH at the plugin level would mean configuring the plugin to 3 MB and doing a larger-cap override for non-images — the plugin doesn't support conditional caps. So: 20 MB at the plugin, 3 MB at the handler. Test R7 hits the plugin's 413; test R8 hits the handler's 413. Different code paths, both covered.

## 6. Tasks (each <2h, R-numbers map to §4)

1. [ ] **Route scaffold + multipart plugin** — `apps/backend/src/routes/attachments.ts`, register under `/api/v1`. Install `@fastify/multipart` (verify via Context7). Wire the two routes; return 501 stubs. Smoke: 401 without cookie (R16). BLOCKED on dep approval (CLAUDE.md #5) — minimal addition.
2. [ ] **Upload happy path (R1, R2, R4, R5, R9)** — `attachments-upload.test.ts`. Fixtures: alice in `general`. Upload 1 KB `.txt` → 201 + attachment row + file on disk at the right path. Assert `storagePath` relative + `originalName` preserved + `comment` stored.
3. [ ] **Upload unicode + sanitization (R4, R10)** — same test file. Upload `"файл.txt"` and `"../../../etc/passwd.png"`; assert no file written outside `UPLOAD_DIR`, assert `originalName` round-trips through the DB column, assert extension sanitized.
4. [ ] **Size caps (R7, R8)** — `attachments-size.test.ts`. Boundary tests: 20 MB +/- 1 non-image; 3 MB +/- 1 image; 4 MB octet-stream (not image) → 201. Plugin 413 vs handler 413 both covered by discrete cases.
5. [ ] **Upload gate branches (R5, R16)** — `attachments-upload-auth.test.ts`. Unauth → 401, non-member → 403, happy → 201. Three branches.
6. [ ] **Download happy path + headers (R6, R11)** — `attachments-download.test.ts`. Upload + link to a message + GET; assert streamed body bytes === uploaded bytes; `Content-Disposition` header round-trips unicode filename.
7. [ ] **Download access check — kicked member (R6, R14)** — `attachments-access-loss.test.ts`. Alice uploads + links. Delete alice's `room_member` row (stand-in for REQ-094 endpoint). Assert alice's GET → 403. Assert bob's GET still 200. Assert file on disk still exists.
8. [ ] **Link step in send (R12)** — **modifies the existing S1-landed send handler body at `apps/backend/src/routes/messages.ts`** (NOT a new route; the existing handler already accepts the `attachmentIds` field from [dto.ts:42](../../packages/shared/src/dto.ts#L42) and currently ignores it). Add the link block inside the existing transaction, ordered: freeze check (if DM, `s2-dms.md` R5 — already landed) → seq allocation (S1) → message INSERT (S1) → attachment SELECT FOR UPDATE + UPDATE (this task). Test file: `messages-send-with-attachments.test.ts`. Four branches: (a) happy 3-attachment link, (b) wrong uploader → 400, (c) wrong room → 400, (d) already-linked → 400. Each asserts transaction rollback (no message row, no seq advance).
9. [ ] **DM parity with freeze (R13)** — `attachments-dm-freeze.test.ts`. Depends on `s2-dms.md` freeze helper landing first. Create DM, upload → 201 (freeze doesn't gate upload). Freeze via friendship-delete. Send with attachment → 409. Assert attachment row messageId IS NULL.
10. [ ] **Protocol addition (R17 + §8 Q1)** — `packages/shared/src/protocol.ts` + tests. Extend `MessagePayload` with `attachments`; update the S1 history handler + send handler to populate the field. BLOCKED on §8 Q1 approval. Tests: `GET /rooms/:id/messages` and `message.new` event both carry `attachments: AttachmentPayload[]`.
11. [ ] **Cascade on room delete — DB-level only (R15)** — `attachments-cascade.test.ts`. Insert an attachment linked to a message in a test room. DELETE the room row. Assert `attachment` row is gone. XFAIL the "file is also gone" assertion with a comment citing `s2-rooms.md` REQ-087.
12. [ ] **Orphan-row behavior documented, not swept** — no task, just the FOLLOWUPS.md entry. Verify [docs/FOLLOWUPS.md:18](../FOLLOWUPS.md#L18) already mentions it (it does — from S1). No change.
13. [ ] **Gate dry-run** — Manual: alice in `general`; drag-drop a ~1 MB JPEG into composer → attachment uploads (<2s); message appears with inline image on bob's browser within 1s; bob clicks download → saves with original filename. Alice kicked (via direct DB delete for now) → alice's re-load shows 403 on the image; bob still sees it.

## 7. Out of scope / follow-ups

### ADR-0006 deviations

v4 catalog rules where S2 intentionally ships less or differently. See [docs/adr/0006-req-catalog-canonical.md](../adr/0006-req-catalog-canonical.md) for the consolidated rationale.

- **v4 REQ-075 executable deny-list** — v4 mandates magic-byte rejection of `.exe`/`.bat`/`.cmd`/`.ps1`/`.vbs`/etc. S2 accepts all MIME types; the `Content-Disposition: attachment` header in R11 is the safety net (browser never auto-executes). Deferred to S3 security pass.
- **v4 REQ-076 SVG sanitization** — v4 requires DOMPurify with `FORBID_TAGS` + `FORBID_ATTR`, plus `Content-Security-Policy: sandbox` on serve. S2 does not sanitize or sandbox SVGs. Deferred to S3.
- **v4 REQ-077 numeric caps** — v4 caps at 25 MB file / 5 MB image (bumped to accommodate modern phone photos). S2 retains v3.docx + BRIEF.md values (20 MB file / 3 MB image). Bump defer to S3 if the demo hits the ceiling.
- **v4 REQ-078 inline image preview endpoint** — v4 mandates a separate `Content-Disposition: inline` endpoint with CSP sandbox for image thumbnails. S2 serves images via the single download endpoint; browsers render via `<img>` tag from the raw handler response. CSP sandboxing deferred to S3.
- **v4 REQ-079 multi-file upload per message** — v4 supports up to 10 files per message in a single multipart request. S2 caps at one file per request; the web client batches by issuing multiple sequential uploads. Multi-part batching deferred.
- **v4 REQ-080 upload progress + cancel UI** — v4 requires per-file progress bar and a cancel affordance. S2 shows a spinner only; cancel is not supported. Deferred.
- **v4 REQ-084 soft-delete + 7-day retention for room deletion** — v4 requires `attachment` and file bytes to survive room delete for 7 days (undo window, GC'd via REQ-163). S2 uses FK `onDelete: cascade` hard-delete; no retention. The GC scheduler is REQ-163 in v4 (out of scope for S2).
- **v4 REQ-085 uploader `/uploads/mine` view** — v4 requires that a user who loses room access can still retrieve their own past uploads via a paginated `/uploads/mine` view. S2 revokes uploader access entirely (R14 is a deviation). Remaining-member persistence half still holds.

### Other follow-ups

- **Inline image rendering in the web client** — owned by `s2-web.md` (the message renderer chooses `<img>` when `attachments[i].mimeType` starts with `image/`, else renders a filename chip). Backend just serves bytes + the right `Content-Type`.
- **Room-delete file cleanup (REQ-087)** — `s2-rooms.md`: when a room is hard-deleted, iterate its attachments + `fs.unlink` each `storagePath` BEFORE the DELETE cascade nukes the rows. Critical contract: this spec's DB cascade leaves dangling files if the other spec doesn't do the unlink. Cited in R15.
- **Message-delete file cleanup (REQ-114)** — `s2-edit-delete.md`: when a message is deleted, `fs.unlink` its attachments' files. Similar to the room-delete contract.
- **Orphan GC (attachments with messageId NULL older than 1h)** — S3 hardening. Tracked in [docs/FOLLOWUPS.md:18](../FOLLOWUPS.md#L18). Risk bounds at 24h hackathon: maybe 10–20 orphans, negligible disk.
- **Signed URLs for downloads (REQ-151)** — S3 hardening. Today downloads go through a handler that checks membership; S3 adds an HMAC-signed 5-minute URL for `<img src>` so each image load doesn't re-auth. The handler survives the upgrade — the signed URL is an optional short-circuit, not a replacement.
- **Image thumbnails + preview UI** — not in v3.docx. Browser-native `<img>` rendering is the S2 UX.
- **Virus scanning / file-type denylist** — not in v3.docx. S3 security pass can add ClamAV or similar; keep it as a separate process reading from `UPLOAD_DIR`.
- **CSP headers for downloaded content** — S3 security pass. Today the handler serves raw bytes; S3 adds `X-Content-Type-Options: nosniff` + a `Content-Security-Policy` on the download response to prevent HTML-typed payloads from rendering.
- **Per-upload rate limit** — S3 hardening (`@fastify/rate-limit`). At 300 concurrent users, naive upload flood could fill UPLOAD_DIR; 30 uploads/min/user is the likely S3 cap. Not enforced in S2.
- **Progress events for large uploads** — frontend can render a spinner tied to the `fetch` call's lifecycle; no backend push needed.

## 8. Open questions

Gating groups:

- **Blocks task 10 (protocol + dto)**: Q1 (MessagePayload.attachments field — protocol change, human approval per CLAUDE.md #5).
- **Blocks task 1 (dependency)**: Q4 (@fastify/multipart add — dep change, CLAUDE.md #5).
- **Scope confirmations, no task-block**: Q2 (mime trust), Q3 (image-cap rejection timing), Q5 (soft-delete column — default "no").

- [ ] **Q1 — Protocol change: `MessagePayload.attachments?: AttachmentPayload[]`** ([protocol.ts:18](../../packages/shared/src/protocol.ts#L18)). Adds an optional array field + a new `AttachmentPayload` interface. Shape: `{ id: string; originalName: string; mimeType: string; sizeBytes: number; comment: string | null; downloadUrl: string }`. `downloadUrl` is relative (`/api/v1/attachments/:id`); the client composes the absolute URL with `NEXT_PUBLIC_BACKEND_URL`. Requires human approval (CLAUDE.md #5 — wire contract change). Alternative: keep `MessagePayload` unchanged and stream attachments via a separate `GET /api/v1/messages/:id/attachments` endpoint — one extra round-trip per message with attachments, worse UX, rejected.
- [ ] **Q2 — Trust the client-reported `Content-Type`.** The multipart plugin exposes the client's `Content-Type` header per part; we store it as-is in `attachment.mimeType`. The image-cap check (R8) and the download response (R11) both use this value. Risks: (a) client lies about mime → e.g. says `image/png` to get past the 3 MB cap check in R8 (but the 20 MB plugin cap still applies, so no storage attack); (b) client lies to make a `.exe` render as `image/png` → browser still downloads because of `Content-Disposition: attachment` (R4), no execution. Options:
    - **(a)** Trust client mime. Simple, no extra dep. Current recommendation.
    - **(b)** Sniff mime with a small library (`file-type` npm package: reads first 4 KB). More correct; adds a dep + a 4 KB pre-read. Defer to S3 hardening.
    - **Recommendation**: (a). The invariants that matter (size caps, no-auto-exec, access control) don't depend on mime truthfulness. S3 security pass can flip to (b) if judges flag it.
- [ ] **Q3 — When to reject 3-MB-cap image.** Options:
    - **(a)** Reject after some bytes have been written to disk (recommendation — simple, <3 MB of wasted I/O).
    - **(b)** Reject via `Content-Length` header pre-read. Faster rejection but trusts the header (the client could lie about the size, though multipart puts the real bytes through regardless).
    - **(c)** Set the plugin cap to 3 MB and temporarily raise it to 20 MB for non-image uploads. Plugin config is per-request-handler in Fastify, doable but adds branching; gains <300 ms in the adversarial case.
    - **Recommendation**: (a). 3 MB of I/O is cheap; the implementation is a `size > 3 MB` check in the handler with `fs.unlink` on reject. Revisit if S3 load-testing flags it.
- [ ] **Q4 — Add `@fastify/multipart` dependency.** Requires human approval (CLAUDE.md #5). The S1 stack has `@fastify/cors` + `@fastify/rate-limit`; multipart is the natural addition. Version: whatever Context7 verifies as compatible with the landed Fastify major at S1 close. No alternative seriously considered — raw request parsing for multipart is a reinvention with zero upside.
- [ ] **Q5 — Soft-delete column on `attachment`.** Schema delta candidate: `attachment.deletedAt timestamp NULL`. Default design does NOT add this — rows are hard-deleted by the FK cascades. Pro: keeps an audit trail of "what did carol upload" after room delete. Con: every access check has to filter `deletedAt IS NULL` forever; soft-delete + later file GC is two cleanup steps instead of one. Recommendation: **no soft-delete**. REQ-087 "all files and images in the room are deleted permanently" + REQ-114 "deleted messages are not required to be recoverable" both favor hard-delete. Flag for reviewer sign-off.
- [ ] **Q6 — DM attachment freeze semantics: do we also reject upload on a frozen DM?** Current design says NO — upload is free, only the link step is frozen (R13). Alternative: check freeze at upload time, reject with 409 if the target room is a frozen DM. Trade-off: upload-time rejection is nicer UX (immediate feedback before the user composes a caption), but adds a coupling between `s2-attachments.md` and `s2-dms.md` in a direction the latter doesn't assume. Recommendation: stay with link-time rejection; the frontend can check freeze status before starting the upload if the UX wants early feedback. Low-stakes scope question.
- [ ] **Q7 — Inherited: `s2-dms.md` Q6 (freeze on soft-deleted counterpart) silently gates R13.** That Q is unresolved upstream; its resolution determines whether DM attachment sends to a soft-deleted counterpart are rejected by the freeze helper (option a: REQ-125 hard-deletes friendship) or by an extended predicate (option b: in-helper deleted check). This spec's R13 does not need to encode the outcome — it delegates to `dm-freeze.ts` — but the test in §6 task 9 must track upstream resolution or XFAIL with a comment citing the inheritance. No independent decision here; re-check when s2-dms Q6 lands.

**Contract gaps spotted (informational):**

- `attachment.uploaderId` FK uses `onDelete: cascade` ([schema.ts:324-326](../../packages/shared/src/schema.ts#L324-L326)). If a user is hard-deleted, their attachment rows vanish — but v3.docx §2.1.4 + REQ-125 describe soft-delete (row retained, `deletedAt` set). Hard-delete is not used in current flows, so the cascade is dormant. If S3 adds a hard-delete admin tool, attachments disappear with the user; the row-deletion leaves files dangling (no cascade between cascade and disk). Flag for the account-deletion spec.
- `attachment.messageId` FK uses `onDelete: cascade` ([schema.ts:320](../../packages/shared/src/schema.ts#L320)). When a message is deleted (REQ-114), the attachment row vanishes. Contract with `s2-edit-delete.md`: unlink the file before the DB cascade runs — same pattern as the room-delete contract (§7).
- No explicit `message_id IS NULL` expiration in the current schema — only the `TODO(S3-GC)` at [schema.ts:318](../../packages/shared/src/schema.ts#L318). Acceptable for S2.

## 9. Gate criteria

Self-check before declaring "S2 attachments done":

- [ ] `pnpm --filter backend test:run` green — all attachment tests pass
- [ ] `pnpm trace` covers v4 REQ-075, REQ-077, REQ-078, REQ-079, REQ-081, REQ-082, REQ-083 (the subset S2 actually implements). v4 REQ-076, REQ-080, REQ-084, REQ-085 are documented as ADR-0006 deviations and are NOT expected to appear as claimed-and-covered
- [ ] Manual (demo step 4): alice drags a ~1 MB JPEG into the DM composer → bob's browser renders the image inline within 1s of alice's send
- [ ] Download preserves original filename (unicode test case in the suite)
- [ ] 20 MB + 1 byte upload rejected with 413 at the plugin layer (no file on disk)
- [ ] 3 MB + 1 byte `image/png` upload rejected with 413 at the handler layer (partial file cleaned up)
- [ ] Kicked member can no longer GET their own former attachments (R14)
- [ ] File on disk survives uploader's access loss (R14)
- [ ] `docker compose up --build` from a fresh clone produces a working `uploads` volume (the `.gitkeep` in `infra/uploads` is the canary — if it's missing, the bind mount fails)

Timebox: S2 soft gate at H+16 (2026-04-18 24:00 UTC). Attachments are the 2nd-most-expensive S2 slice (after DMs) but they're the **single feature most visible in the demo**. If R13 (DM freeze parity) slips, ship the group-room attachment path and defer DM parity — the demo still shows the upload if alice and bob use `general`.

## 10. Acceptance test outline (REQ → test mapping)

| REQ-ID | How exercised | Layer |
| --- | --- | --- |
| REQ-075 | Upload accepts any MIME; deny-list deferred per ADR-0006 | integration |
| REQ-077 | 20 MB file boundary + 3 MB image boundary (+1 → 413, exact → 201). v4 caps 25/5 MB — see ADR-0006 | integration |
| REQ-078 | Download serves `Content-Disposition: attachment` with unicode `filename*` roundtrip | integration |
| REQ-079 | Button/drag/paste all hit `POST /api/v1/attachments` (frontend contract; backend covers one path); single-file per request (multi-file batching deferred per ADR-0006) | integration (backend) + e2e (frontend) |
| REQ-081 | Original filename preserved verbatim through upload → DB → download; on-disk path sanitized to UUID | integration |
| REQ-082 | Optional `comment` (≤500 chars) stored and returned | integration |
| REQ-083 | Non-member GET → 403 (two branches: never-member, ex-member); membership recomputed per-request | integration |
