# Spec: S2 e2e coverage scaffolding (browser-level)

**Status**: draft (awaiting human approval)
**Branch**: `feat/e2e-scaffolding` (worktree: `../hackaton-e2e-scaffolding`)
**Owner (human)**: hackathon human
**Owner (agent)**: Claude Code (agent G, parallel run)

**Binding source**: [`/task/2026_04_18_AI_herders_jam_-_requirements_v3.docx`](../../../task/2026_04_18_AI_herders_jam_-_requirements_v3.docx). `/task/*.md` files are AI-prep, REQ-ID hooks only.

## 0. Scope at a glance

Wave-1 + Wave-2 merged features landed without browser-level e2e (except `s2-invitations.spec.ts` which is partial). This spec defines Playwright scenarios per REQ-ID for:

| Feature (agent) | v3.docx | REQ-IDs claimed here | Agent status |
| --- | --- | --- | --- |
| Sessions list + revoke (D) | §2.2.4 | REQ-017, REQ-018 | merged |
| Room moderation (A) | §2.4.7, §2.4.8 | REQ-201, REQ-202, REQ-203, REQ-205, REQ-206, REQ-208, REQ-211 | merged |
| Private rooms + invitations (B) | §2.4.2, §2.4.4, §2.4.9 | REQ-088, REQ-089, REQ-089a | merged (partial e2e already exists) |
| Replies (C) | §2.5.2, §2.5.3 | REQ-110, REQ-133 | merged |
| Attachment comment + access-revoke (E) | §2.6.3, §2.6.4 | — scaffolded as `test.skip`, bound to v3.docx §§ until E lands | in-flight |
| Catalog search (F) | §2.4.3 | — scaffolded as `test.skip` | in-flight |
| Emoji picker (F) | §2.5.2 | — scaffolded as `test.skip` | in-flight |
| DM unread (F) | §2.7 | — scaffolded as `test.skip` | in-flight |

REQ-IDs for E and F are deliberately NOT claimed in §4 below — those agents own their spec `§4` and will cite canonical REQ-IDs at merge time. Skeleton tests carry TODO comments keyed to v3.docx sections so renaming to the real IDs is a one-line edit per test.

## 1. Why

- Every merged Wave-1 + Wave-2 spec carries FOLLOWUPS entries asking for dual-browser / cross-user browser smokes. Those are batched per `feedback-batched-smoke`, but the Playwright code to execute them has to exist first.
- `scripts/trace-req-ids.mjs` already red-flags REQ-201..REQ-211 and REQ-110/REQ-133 as spec-claimed-but-untested at the browser layer (the backend tests cover them, but `pnpm trace` can't distinguish layers — the coverage assertion still wants a test-file reference, and that reference benefits from being an actual browser journey rather than a stub).
- Agents E/F are merging after this scaffolding lands. Pre-landing a skeleton + spec means the "green on first merge" window is minutes, not hours.

## 2. Non-goals

- **No feature code.** Zero edits under `apps/web/src/**`, `apps/backend/src/**`, `packages/shared/**`, `infra/**`.
- **No Playwright config overhaul.** `playwright.config.ts` stays chromium-only; two `browser.newContext()` calls give independent cookie jars (MCP's single-context constraint does not apply to raw Playwright — see §5).
- **No storageState / auth fixture.** Register fresh users per-test. `workers: 1` already serializes; parallelism is not a fit during the hackathon.
- **No DB seed.** Backend tests seed their own fixtures; e2e creates users via `/register` and rooms via `POST /api/v1/rooms` through the UI.
- **No actual `pnpm test:e2e` execution on main.** Agents E/F's UI isn't merged; reds are expected. We verify discovery with `pnpm test:e2e --list` only.
- **No rewrite of `tests/e2e/s2-invitations.spec.ts`.** It's agent B's file; we add a sibling for decline coverage rather than editing in place.

## 3. User stories

- As the human QA, after each submission-gate checkpoint I run `pnpm test:e2e` and every wave-1+2 feature has at least one browser-level happy-path scenario.
- As the human at agent-E/F merge time, I unskip the relevant `test.skip(...)` by deleting the TODO line and replacing the section-ID name with the canonical REQ-ID — no other edits required.
- As `scripts/trace-req-ids.mjs`, every REQ-ID claimed in §4 below has at least one matching test-file reference the moment this branch lands.

## 4. Requirements (testable)

Each R is one browser scenario; REQ-IDs embedded in the R name are the trace anchors.

### Sessions (agent D, §2.2.4)

- [ ] **R1 (REQ-017)**: Alice registers, visits `/settings/sessions`, sees a table with exactly one row tagged "This browser". The row shows Browser / IP / Last active / Created / Status / Action columns.
- [ ] **R2 (REQ-018)**: Alice opens a second session in an isolated BrowserContext (second login), returns to Chrome `/settings/sessions`, clicks "Sign out" on the non-current row; the row disappears optimistically, a success toast fires, and the second context's next navigation to `/rooms` redirects to `/login` (RequireSession on 401).
- [ ] **R3 (REQ-018)**: On a single context with one session, clicking "Sign out this browser" navigates to `/login`. (Separate test so R2's second context isn't needed.)

### Moderation (agent A, §2.4.7–8)

- [ ] **R4 (REQ-201, REQ-207)**: Owner Alice opens Manage Room → Admins tab → promotes member Bob; Bob's MembersTab row role badge flips from `member` to `admin` live (via `room.role.changed` socket event). Uses two BrowserContexts.
- [ ] **R5 (REQ-202)**: Alice (owner) demotes admin Bob via AdminsTab → `Remove admin` → confirm modal. Bob's role badge flips to `member`. Alice cannot demote herself — owner row has no `Remove admin` button (assert absence).
- [ ] **R6 (REQ-203, REQ-208)**: Alice kicks Bob via MembersTab → `Remove from room` → confirm. Within 2s Bob's `RoomClient` observes `room.member.kicked` and navigates out of the room channel; a subsequent `message.new` sent by Alice is not visible in Bob's message list. (Browser-layer re-assertion of the REQ-208 invariant that backend integration tests already nail at the socket layer.)
- [ ] **R7 (REQ-205)**: Alice unbans Bob via BannedTab → `Unban` → confirm. Bob visits `/rooms` catalog, clicks the public-room Join button, lands in the room with full history. (Ban-gate path is REQ-079 but the observable outcome is unban → rejoin.)
- [ ] **R8 (REQ-206, REQ-211)**: Alice opens Manage Room → Banned tab → sees the `Username | Banned by | Date/time | Unban` row for Bob (seeded via an earlier REQ-204 ban or the REQ-203 kick path). Plain-member Carol opens the same modal → Banned tab renders the empty-state "Only admins can view the ban list."

### Invitations + private rooms (agent B, §2.4.2/4/9)

- [ ] **R9 (REQ-088)**: Bob's `/rooms` catalog does NOT list Alice's private room before invite+accept. (Already asserted inline in `tests/e2e/s2-invitations.spec.ts:111` — documenting, not re-writing.)
- [ ] **R10 (REQ-089)**: Alice invites Bob; Bob accepts; Bob lands in the room. (Already in `tests/e2e/s2-invitations.spec.ts`.)
- [ ] **R11 (REQ-089)**: Alice invites Bob; Bob declines from InboxList; Bob's inbox row disappears, Alice's `Pending invitations` list drops the row live (client-side filter on `room.invitation.declined` per [InvitationsTab.tsx:62-79](../../apps/web/src/components/chat/manage-room/InvitationsTab.tsx#L62-L79) — no "declined" status badge; the row is simply removed). **New test**, sibling file `tests/e2e/s2-invitations-decline.spec.ts` so agent B's file stays untouched.
- [ ] **R12 (REQ-089, REQ-089a)**: Cancel asymmetry — already covered in `s2-invitations.spec.ts` second test. Documenting; no new code.

### Replies (agent C, §2.5.2/3)

- [ ] **R13 (REQ-110, REQ-133)**: Alice sends `hello` in `#general`; Bob hovers, clicks Reply, composer shows `[Replying to: Alice ×]`, Bob sends `hi alice`. Alice's `MessageList` shows Bob's message with a quoted block containing `Alice: hello`. (Two BrowserContexts.)
- [ ] **R14 (REQ-110)**: Parent-delete live-flip — Alice sends `parent`; Bob replies; Alice deletes `parent` via MessageActions → Delete; Bob's view of the quoted block flips to `[deleted]` within 2s (no page reload). Asserts spec §4 R11 FE reducer end-to-end.
- [ ] **R15 (REQ-133)**: Single-browser composer chip — click `×` on the chip clears reply-to state; the next send carries no quoted block. No dual-user needed.

### Attachments (agent E, §2.6.3/4) — SKELETON, test.skip

- [ ] **S1 (v3.docx §2.6.3, TODO E)**: `test.skip` — Alice uploads image + comment "first look"; Bob sees the image with the comment below it; Bob replies with a comment of his own via a comment-input UI surface whose selector E will define. Unskip and replace `§2.6.3` with E's real REQ-ID post-merge.
- [ ] **S2 (v3.docx §2.6.4, TODO E)**: `test.skip` — Alice revokes her own uploaded file's access; Bob's MessageList renders `[file removed]` (or whichever placeholder E chooses) live. Unskip post-merge with E's REQ-ID.

### Catalog search / emoji / DM unread (agent F) — SKELETON, test.skip

- [ ] **S3 (v3.docx §2.4.3, TODO F)**: `test.skip` — catalog search box filters room list as user types; empty-state shows "No rooms match." Unskip post-merge with F's REQ-ID.
- [ ] **S4 (v3.docx §2.5.2, TODO F)**: `test.skip` — emoji-picker trigger opens a picker; clicking an emoji inserts it at the composer cursor and keeps focus. Unskip post-merge with F's REQ-ID.
- [ ] **S5 (v3.docx §2.7, TODO F)**: `test.skip` — Alice sends Bob a DM; Bob's DM tab badge shows `1`; opening the DM clears the badge on next paint. Unskip post-merge with F's REQ-ID.

## 5. Design notes

### Test location

`tests/e2e/` (confirmed — `apps/web/tests/` does not exist and `playwright.config.ts` points to `./tests/e2e`). One file per feature area:

```text
tests/e2e/s2-sessions.spec.ts            # R1, R2, R3
tests/e2e/s2-moderation.spec.ts          # R4–R8
tests/e2e/s2-invitations-decline.spec.ts # R11 (sibling to agent B's s2-invitations.spec.ts)
tests/e2e/s2-replies.spec.ts             # R13, R14, R15
tests/e2e/s2-attachments.spec.ts         # S1, S2 (skip)
tests/e2e/s2-catalog-search.spec.ts      # S3 (skip)
tests/e2e/s2-emoji-picker.spec.ts        # S4 (skip)
tests/e2e/s2-dm-unread.spec.ts           # S5 (skip)
```

### Multi-user pattern: two `browser.newContext()`, same chromium

Per `feedback-playwright-multi-user` the MCP driver collapses to one cookie jar because a single `BrowserContext` is shared across navigations. Non-MCP Playwright's `browser.newContext()` allocates an isolated storage partition per call, which is what `tests/e2e/s2-invitations.spec.ts:100-101` already uses successfully for Alice+Bob. The FOLLOWUPS.md entries that ask for Chrome+Firefox are after-the-fact engine-divergence hedges — **out of scope for this scaffolding** (see §8 Q3).

### Backend-health gate

Every new spec uses the same `beforeAll` pattern as `s2-invitations.spec.ts:75-80`:

```ts
test.beforeAll(async () => {
  const res = await fetch("http://localhost:4000/health").catch(() => null);
  test.skip(!res || !res.ok, "Backend not healthy at :4000/health — docker compose up --build -d");
});
```

This way `pnpm test:e2e --list` works without a running stack, and live runs skip (not red) when the human hasn't booted docker.

### Auth helper

Duplicate `registerAndEnterRooms()` from `s2-invitations.spec.ts:26-38` into each new spec. A shared helper under `tests/e2e/_helpers/` is a style improvement, not a blocker — defer per YAGNI unless a third file shares the exact flow. (The invitations file already has one copy; a second copy here is the break-even point; a third file tips the balance toward extraction. See §8 Q2.)

### `test.skip()` convention for E/F

```ts
test("REQ-TBD (§2.6.3, TODO E: unskip post-merge) attachment comment round-trip", async ({ browser }) => {
  test.skip(true, "TODO(agent-E): unskip after feat/attach-comment-revoke merges; replace §2.6.3 with real REQ-ID");
  // scaffold body below so merge is a test.skip → test delete
});
```

`test.skip(true, reason)` stays green in reports and the name still embeds a traceable anchor (`§2.6.3`) until the REQ-ID lands. `test.fixme()` is an alternative that surfaces as "expected failure"; I picked `.skip()` because the test body is not yet meaningful — fixme implies we know the assertion and can't make it pass, skip implies we haven't written it.

### Trace discipline

Test names embed REQ-IDs exactly as claimed in §4. Running `TRACE_VERBOSE=1 pnpm trace` on this branch should show every REQ-ID in §4 moving into the `Covered` bucket (REQ-017, REQ-018, REQ-088, REQ-089, REQ-089a, REQ-110, REQ-133, REQ-201, REQ-202, REQ-203, REQ-205, REQ-206, REQ-207, REQ-208, REQ-211). REQ-204/REQ-209/REQ-210 are covered elsewhere (backend + component tests); we do NOT re-claim them here to avoid zombie inflation.

### React-hook-form / SPA transition hazard

`feedback-playwright-rhf-spa-transition`: after `<Link>` clicks, either `await page.goto(destination)` or `await expect(page.locator(destSelector)).toBeVisible()` before the next `fill()`. Called out in every spec's helper.

## 6. Tasks (one PR-worthy commit each, ff-only)

1. [ ] Draft + land this spec (`docs/specs/s2-e2e-coverage.md`). Commit: `docs(e2e-coverage): spec for s2 browser-level coverage + skeleton for agents E/F`.
2. [ ] Scaffold `tests/e2e/s2-sessions.spec.ts` (R1–R3). Commit: `test(e2e): REQ-017/REQ-018 sessions list + revoke + self-revoke redirect`.
3. [ ] Scaffold `tests/e2e/s2-moderation.spec.ts` (R4–R8). Commit: `test(e2e): REQ-201/202/203/205/206/207/208/211 moderation browser flows`.
4. [ ] Scaffold `tests/e2e/s2-invitations-decline.spec.ts` (R11). Commit: `test(e2e): REQ-089 invitation decline updates both inboxes`.
5. [ ] Scaffold `tests/e2e/s2-replies.spec.ts` (R13–R15). Commit: `test(e2e): REQ-110/REQ-133 replies + parent-delete live-flip + composer chip clear`.
6. [ ] Scaffold `tests/e2e/s2-attachments.spec.ts` (S1, S2 skip). Commit: `test(e2e): skeleton for agent-E §2.6.3/§2.6.4 (test.skip until merge)`.
7. [ ] Scaffold `tests/e2e/s2-catalog-search.spec.ts`, `tests/e2e/s2-emoji-picker.spec.ts`, `tests/e2e/s2-dm-unread.spec.ts` (S3–S5 skip). Commit: `test(e2e): skeleton for agent-F §2.4.3/§2.5.2/§2.7 (test.skip until merge)`.
8. [ ] Run `pnpm test:e2e --list` and paste output into the final commit message body. Append a FOLLOWUPS.md entry summarising live vs skipped counts. Commit: `docs(followups): queue S2 e2e scaffolding runtime verification for next docker checkpoint`.

## 7. Out of scope / follow-ups (for FOLLOWUPS.md)

- **Chrome+Firefox Playwright projects.** The existing multi-user entries in FOLLOWUPS.md ask for this. Deferred — scaffolding stays chromium-only; at the submission-gate checkpoint, if cross-engine divergence is required for evidence, add a `firefox` project to `playwright.config.ts`. Flag: config edit is non-trivial (`webServer` reuse + matcher rework) and out of this spec's hands-off contract.
- **Shared helpers under `tests/e2e/_helpers/`.** Extract `registerAndEnterRooms`, `createPublicRoom`, `createPrivateRoom`, `sendMessageAs` once a third spec duplicates them. Not before.
- **Actual dual-browser smoke runs.** Per `feedback-batched-smoke` these stack with the next docker-compose checkpoint.
- **R14 cross-room reply rejection (REQ-110 §4 R3 in s2-replies.md).** Not reachable via the browser UI — the composer's reply chip only attaches to messages the user can see, and the send path blocks cross-room at the server. Backend already covers it.

## 8. Open questions (MUST resolve before approval)

- [ ] **Q1**: OK to claim REQ-017/REQ-018 in this coverage spec's §4 even though `s2-sessions-ui.md` §4 uses R1–R11 without REQ-IDs? Alternatives: (a) agent G claims them here (proposed); (b) edit `s2-sessions-ui.md` §4 to add REQ anchors (violates hands-off); (c) drop sessions e2e coverage from this scaffolding.
- [ ] **Q2**: Extract `registerAndEnterRooms` into `tests/e2e/_helpers/register.ts` now (four call sites: invitations-decline + moderation + replies + sessions), or duplicate inline per hackathon YAGNI? Proposed: duplicate now; extract only if one of us touches a fifth spec this week.
- [ ] **Q3**: Approve chromium-only as the scaffolding baseline, with Chrome+Firefox deferred to the FOLLOWUPS batched-smoke checkpoint? Or add a firefox project to `playwright.config.ts` now? (This is the "playwright.config non-trivial change" the task brief asks me to flag up-front.)
- [ ] **Q4**: `test.skip(true, reason)` vs `test.fixme()` for agents E/F placeholders — proposed `.skip()` (see §5 design).
- [ ] **Q5**: R14 (parent-delete live-flip) asserts `text === "[deleted]"` or the quoted block's `data-state="deleted"` attribute? The former is the user-visible string, the latter is stabler. Proposed: both — visible text is the primary assertion, `data-state` backstops against i18n churn. Confirm naming with agent C's merged MessageList if different.

## 9. Gate criteria (self-check before "done")

- Every REQ-ID in §4 appears as a string in at least one `test(...)` or `describe(...)` name.
- `pnpm test:e2e --list` parses every new file (no TS/Playwright syntax errors).
- `pnpm trace` reports the §4 REQ-IDs under `Covered` with this branch's files in their source list; no new zombie IDs.
- Zero edits under `apps/web/src/**`, `apps/backend/src/**`, `packages/shared/**`, `infra/**`, `playwright.config.ts` (if touched, Q3 must be answered yes).
- FOLLOWUPS.md has a single appended entry covering this scaffolding's deferred smoke runs.

## 10. Acceptance test outline (REQ → file mapping)

| REQ / anchor | File | Test name contains |
| --- | --- | --- |
| REQ-017 | `s2-sessions.spec.ts` | `REQ-017 sessions list renders one current row` |
| REQ-018 | `s2-sessions.spec.ts` | `REQ-018 revoke non-current`, `REQ-018 self-revoke` |
| REQ-201 | `s2-moderation.spec.ts` | `REQ-201 promote member to admin` |
| REQ-202 | `s2-moderation.spec.ts` | `REQ-202 demote admin; owner row has no remove-admin` |
| REQ-203, REQ-208 | `s2-moderation.spec.ts` | `REQ-203 REQ-208 kick-as-ban force-leaves target socket` |
| REQ-205 | `s2-moderation.spec.ts` | `REQ-205 unban then target rejoins public room` |
| REQ-206, REQ-211 | `s2-moderation.spec.ts` | `REQ-206 REQ-211 banned tab roster + member empty-state` |
| REQ-207 | `s2-moderation.spec.ts` | embedded in R4/R6 describe name |
| REQ-088 | (existing) `s2-invitations.spec.ts` | already present |
| REQ-089 | `s2-invitations.spec.ts` (happy) + `s2-invitations-decline.spec.ts` (decline) | `REQ-089 decline removes invite row both sides` |
| REQ-089a | (existing) `s2-invitations.spec.ts` cancel asymmetry | already present |
| REQ-110, REQ-133 | `s2-replies.spec.ts` | `REQ-110 REQ-133 reply round-trip cross-user`, `REQ-110 parent-delete flips to [deleted]`, `REQ-133 composer chip clear` |
| §2.6.3 (TODO E) | `s2-attachments.spec.ts` | `REQ-TBD §2.6.3 attachment comment round-trip (test.skip)` |
| §2.6.4 (TODO E) | `s2-attachments.spec.ts` | `REQ-TBD §2.6.4 attachment access-revoke flips placeholder (test.skip)` |
| §2.4.3 (TODO F) | `s2-catalog-search.spec.ts` | `REQ-TBD §2.4.3 catalog search filters + empty state (test.skip)` |
| §2.5.2 (TODO F) | `s2-emoji-picker.spec.ts` | `REQ-TBD §2.5.2 emoji picker inserts at cursor (test.skip)` |
| §2.7 (TODO F) | `s2-dm-unread.spec.ts` | `REQ-TBD §2.7 DM unread badge + clear on open (test.skip)` |

---

## Stop gate

Per CLAUDE.md §Workflow — **no file scaffolding until this spec is approved.** Awaiting human sign-off on §8 Q1–Q5.
