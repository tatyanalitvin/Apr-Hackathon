# Spec: Catalog search + emoji picker + DM-unread parity

**Status**: draft
**Branch**: `feat/catalog-emoji-dm-unread`
**Owner (human)**: Tatiana
**Owner (agent)**: Claude Code (agent F)

## 1. Why

Three small wave-2 gaps against v3.docx:

- **§2.4.3** — public-room catalog has memberCount DESC ordering but no search; users with 30+ rooms on `/rooms/browse` cannot find a specific room without scrolling.
- **§2.5.2** — messages already round-trip UTF-8 (emoji copy/paste works end-to-end), but §2.5.2 also asks for an in-composer picker so users don't have to leave the app.
- **§2.7** — unread counters exist for group rooms. §2.7 asks the same parity for DMs. We believe it already works (same `lastReadSeq` / `roomHeadSeq` machinery on kind='dm' rooms via `/rooms/me`) but it's never been explicitly covered by a test. Verify-then-patch-only-if-broken.

## 2. Non-goals

- No change to catalog ordering, catalog filter rules, or moderation block in `routes/rooms.ts` (other agents' ownership).
- No change to DM creation/listing endpoints; this is a read-path audit only.
- No emoji autocomplete (`:smile:` → 😀) in the textarea — picker only.
- No recent-emoji persistence across sessions; library default "recent" behaviour is good enough.
- No rich-text rendering changes; emoji flows through `body` as plain UTF-8 (already shipped).

## 3. User stories

- As a user browsing rooms, I can type a few letters into a search box and see the public-room list narrow to matching names, so that I can find a room by name without scrolling.
- As a user composing a message, I can click a smile button next to Send, pick an emoji, and have it inserted at my textarea caret, so that I don't need an OS picker.
- As a user with an active DM, the DM row in my rooms list shows the same unread-count badge as a group room, so that I don't miss DM pings.

## 4. Requirements (testable)

Each requirement has a test hook listed in the REQ-IDs column of `pnpm trace`.

- [ ] **R1** (REQ-025, §2.4.3): `GET /api/v1/rooms?q=<term>` filters the public-group catalog by `ILIKE '%' || term || '%'` on `room.name`. Existing `kind='group' AND visibility='public'` filter is preserved. `q` omitted or empty → existing behaviour (all public-group rooms, backward compat).
- [ ] **R1b** (§2.4.3, back-compat corollary): whitespace-only `q` (e.g. `"   "`) degrades to the unfiltered path — same response as `q` omitted. Covered by an explicit test so a future refactor that swaps trim semantics trips a red test, not a stealth behaviour change.
- [ ] **R2** (§2.4.3): `q` is zod-validated — optional string, max 64 chars. Over-length returns 400 `invalid_query`.
- [ ] **R3** (§2.4.3, security): A private room whose name contains the search term does NOT surface in `GET /rooms?q=...`. Explicit test: private "core-team" + query "team" returns empty.
- [ ] **R4** (§2.4.3, web): `/rooms/browse` renders an `<input type="search">` above the list. `onChange` is debounced 300 ms and re-fetches `listRoomCatalog({ q })`. Empty result with a non-empty `q` renders "No rooms match your search."; empty `q` with no rooms keeps the existing "No public rooms yet." copy.
- [ ] **R5** (§2.5.2, UI): In `MessageComposer.tsx`, the action row next to Send has a `<Smile />` lucide button. Clicking toggles a popover containing the emoji picker. Picking an emoji inserts its character at the textarea's current caret position (preserving surrounding text). Popover closes on pick or Esc.
- [ ] **R6** (§2.5.2, end-to-end): RTL test — click emoji button → pick 🎉 → textarea shows 🎉 → click Send → `onSend` is called with a body containing 🎉.
- [ ] **R7** (§2.7, DM unread audit): Alice + Bob share a DM. Bob inserts 3 messages. `GET /rooms/me` for Alice returns a row with `roomHeadSeq - lastReadSeq === "3"` on the DM row (both values are strings per ADR-0003). `POST /rooms/:id/read` with `lastReadSeq = roomHeadSeq` resets the unread delta to 0.
- [ ] **R8** (§2.7, test-first discipline): R7 is the *only* change required unless the test fails. If the test fails, the fix lands as a minimal `/rooms/me` patch and R8 becomes "document the patch and re-run R7 green".

## 5. Design notes

### Catalog `q` (R1/R2/R3/R4)

- **DTO** (`packages/shared/src/dto.ts`): add

  ```ts
  export const roomCatalogQuerySchema = z.object({
    q: z.string().max(64).optional(),
  });
  ```

  No NFC / regex constraint — rooms accept unicode names (NFC-normalised on create per REQ-021), and `ILIKE` on the server is case-insensitive.
- **Handler** (`apps/backend/src/routes/rooms.ts`, **catalog block only** — the `app.get("/rooms", …)` handler beginning at the `// R3 / REQ-025` comment; do NOT edit any other handler in this file):
  1. Parse `request.query` through `roomCatalogQuerySchema`. Invalid → 400 `invalid_query`.
  2. If `q?.trim()` is a non-empty string, AND `ilike(room.name, '%' + q.trim() + '%')` onto the existing `and(eq(kind,'group'), eq(visibility,'public'))` conjunction (drizzle's `ilike` helper uses parameterised placeholders, so `%` in user input is an escape-free literal).
  3. Empty / whitespace-only `q` (and omitted `q`) degrade to the existing unfiltered path (R1b back-compat corollary).
  4. Ordering (`memberCount DESC, name ASC`) unchanged.
  5. Raw `%`/`_` inside `q` are NOT escaped — §2.4.3 "simple search" doesn't ask for wildcard-escape semantics, and a user searching for a literal `%` in a room name is an edge we don't owe.
- **Client API** (`apps/web/src/lib/chat-api.ts`): widen `listRoomCatalog(input?: { q?: string }): Promise<RoomCatalogEntry[]>`. The `ChatAPI` interface gets the same `input?` arg. URL is `…/rooms?q=<encoded>` only when `q` is a non-empty string; otherwise plain `…/rooms` (so old call sites are untouched on the wire).
- **Browse page** (`apps/web/src/app/rooms/browse/page.tsx`): controlled `query` state, 300 ms debounce via `setTimeout`/`clearTimeout` (mirror `composer-draft` debounce pattern). Input uses shadcn `Input` (already present). Empty state gated on `query.trim().length > 0 ? no-match-copy : existing-copy`.

### Emoji picker (R5/R6)

- **Library**: `emoji-picker-react` (verified via Context7 — `/ealush/emoji-picker-react`, React 19 compatible, MIT). Import is `import EmojiPicker, { EmojiStyle } from 'emoji-picker-react'`. `onEmojiClick(emojiData) → emojiData.emoji: string`.
- **Bundle budget**: use `emojiStyle={EmojiStyle.NATIVE}` — this switches the picker to render the user's system emoji font instead of loading CDN PNGs per style, which is both smaller on the wire and avoids every-emoji-image-network-fetch on open. If the *dependency itself* pushes web bundle >200 KB delta, or React 19 peer-conflicts, we fall back to `StaticEmojiGrid.tsx` (top-50 from `suggested`/`smileys_people`) — kill-switch #1.
- **Popover**: shadcn ships a `Popover` but it's not installed here. Rather than add a new shadcn primitive for one site, we wrap with a minimal positioned `<div>` + click-outside + Esc handler inside a new `apps/web/src/components/emoji/EmojiPickerButton.tsx`. Lazy-imports the picker (`React.lazy` + `Suspense`) so the dep isn't in the initial bundle — only when the user opens it.
- **Caret insert**: ref the `TextareaAutosize`'s underlying `<textarea>` via its `inputRef` prop. On pick, read `selectionStart`/`selectionEnd`, splice the emoji string in, set `value` through `setValue`, then restore caret to `start + emoji.length` on the next tick.
- **MessageComposer surgery** (zone-bounded, additive-only):
  - Props change is **additive only**: one optional new prop `renderEmojiTrigger?: (onPick: (e: string) => void) => ReactNode`. Every existing prop and callback signature is unchanged. Default-on render: the composer renders `<EmojiPickerButton onPick={insertAtCaret} />` at the marker. The optional prop lets the RTL test stub the real dep out.
  - **Zone**: the `// AGENT-F: emoji zone` marker sits mid-row inside the bottom `flex items-center justify-between` action row. Since `justify-between` with a third child puts the emoji trigger in the middle (awkward), the edit regroups the row into two sub-divs: `<div class="flex items-center gap-2">{bytes-span}{emoji-trigger}</div>` on the left, Send `<Button>` on the right. This touches the existing action-row `<div>` (the whole block from its opening `<div className="flex items-center justify-between">` down through the Send button) — well inside the conceptual emoji zone, well away from AGENT-E's attachment-preview zone at the top of the component and from the reply-chip block above the textarea.
  - Pass the textarea ref down from the existing hook. No other prop or callback signature changes; existing RTL tests (reply-chip, attachments, byte-counter, draft) must continue to pass unmodified.
- **Accessibility**: `<button aria-label="Insert emoji">`, popover focus-trap on open, Esc closes, click outside closes. Matches existing dialog / reply-chip a11y patterns.

### DM unread parity (R7/R8)

- **Audit** (read-only): `/rooms/me` already SELECTs `messageSeq.seq` (roomHeadSeq) and `roomMember.lastReadSeq` over every row in `roomMember` joined to `room` — the WHERE only filters `userId = caller`, no `kind` discriminator. So DMs should already surface with correct unread math.
- **Test** (`apps/backend/tests/dm-unread-parity.test.ts`):
  1. Register alice + bob.
  2. Insert kind='dm' room + two `room_member` rows (alice, bob), `lastReadSeq=0n` for both. Seed `message_seq=0n`.
  3. Insert 3 messages from bob with `seq = 1n, 2n, 3n`; bump `message_seq` to 3n (use existing `onConflictDoUpdate` helper). **Fixture-only shortcut**: production writes to `message` always flow through the `/rooms/:id/messages` POST handler, which atomically increments `message_seq` and emits the `{seq, roomHeadSeq}` watermark (ADR-0003 non-negotiable #6). The test bypasses the allocator purely to set up a deterministic read-state; no runtime code follows this pattern.
  4. Alice `GET /rooms/me` → row where `id=dmId` has `roomHeadSeq="3"`, `lastReadSeq="0"`.
  5. `POST /rooms/:id/read` with `lastReadSeq=3n` → subsequent `/rooms/me` returns `lastReadSeq="3"`, `roomHeadSeq="3"`, delta 0.
- **If R7 fails** (DM row missing entirely, roomHeadSeq wrong, etc.): STOP and flag before patching. Per brief kill-switch #3, if broken, log as S3 and ship test-only claim with `// TODO(hackathon):` marker. Per non-negotiable, we do not touch `/rooms/me` selection shape or `/rooms/:id/read` mechanics without explicit human approval (cross-feature).
- **Expected outcome**: R7 passes as-is. Commit the test as REQ-coverage and add "§2.7 DM unread verified" to FOLLOWUPS.md under "Resolved".

## 6. Tasks (3-8, each <2h)

**REQ-ID tagging convention**: `pnpm trace` greps test files for REQ-ID / §-tokens. Every new `describe`/`it` in this branch MUST contain the relevant literal token in its name so trace picks it up from the new file alone (not an older file that happens to reference the same REQ).

1. [ ] Write failing backend test `apps/backend/tests/rooms-catalog-search.test.ts` covering R1/R1b/R2/R3. Test names MUST include the literal strings **"REQ-025"** and **"§2.4.3"** so `pnpm trace` matches. Implement `q` param in `dto.ts` + `routes/rooms.ts` catalog block → green → commit.
2. [ ] Extend `ChatAPI.listRoomCatalog` to accept `{ q }` → update `/rooms/browse/page.tsx` with debounced search input → commit. Smoke-only on the web side (no Playwright in this branch — picks up at wave-3 smoke).
3. [ ] Context7-verify `emoji-picker-react` (done — see §5), add dep to `apps/web/package.json`, `pnpm install`. If `pnpm install` emits peer-dep warnings for React 19 or the production bundle delta exceeds 200 KB: switch to `StaticEmojiGrid` per kill-switch #1; same component surface, same tests.
4. [ ] Create `apps/web/src/components/emoji/EmojiPickerButton.tsx` (lazy-loaded) + wire into MessageComposer inside the `AGENT-F` marker zone. Add a new `describe("MessageComposer emoji picker (§2.5.2)", …)` block to `MessageComposer.test.tsx` — block name MUST include **"§2.5.2"**. Tests for R5/R6. Do NOT touch reply-chip or attachment describe blocks.
5. [ ] Write `apps/backend/tests/dm-unread-parity.test.ts`. Describe block name MUST include **"§2.7"**. Run it. If green: commit test + append "§2.7 DM unread verified" to `docs/FOLLOWUPS.md` Resolved list. If red: STOP and raise with human.
6. [ ] Gate checks: `pnpm --filter backend test:run rooms-catalog-search dm-unread-parity` green, `pnpm --filter web typecheck` green, `pnpm --filter web test:run MessageComposer` green, `pnpm trace` reports green on §2.4.3, §2.5.2, §2.7 (and the existing REQ-025 hit continues to pass).
7. [ ] Update FOLLOWUPS.md with any deferred smoke (dual-browser Playwright for search + emoji).

## 7. Out of scope / follow-ups

- Emoji autocomplete (`:smile:`).
- Custom emoji upload per workspace.
- Fuzzy search ranking (current plan is simple ILIKE contains; §2.4.3 explicitly says "simple search").
- Catalog pagination — still unbounded, matches existing handler.
- Cross-browser emoji rendering parity (we ship `NATIVE`; emoji may render differently on Windows vs Mac — acceptable for hackathon).

## 8. Open questions

- [ ] Accept `q` as a trimmed+lowered string in the DTO or keep raw and lower inside the handler? → **Resolved**: lowering in the SQL (`LOWER(name) LIKE LOWER('%' || q || '%')`) keeps the DTO minimal and ensures case-insensitivity regardless of client behaviour.
- [ ] Does `pnpm --filter web typecheck` need to see the dep before the first commit (lazy import type)? → **Resolved**: `React.lazy(() => import('emoji-picker-react'))` types resolve once the dep is installed; we install in task 3 before writing the lazy wrapper.
