# UI Exploratory Findings — 2026-04-20

**Branch:** `verify/ui-exploratory` (DO NOT MERGE without human review)
**Stack under test:** `docker compose up` (production build) from `hackathon-starter`; commit `cc53141`.
**Tooling:** Playwright MCP for live exploration, new specs in [tests/e2e/exploratory/](./).
**Seeded users used:** `alice@herders.local` / `bob@herders.local` / `carol@herders.local` — password `hunter2hunter2`.
**Results at time of writing:** 19 passed, 13 failed. Failures = findings (by design).

## How to re-run

```bash
# from hackaton-ui-explore/ (this worktree)
docker exec hackathon-starter-redis-1 redis-cli FLUSHDB   # drop stale /24 sign-up bucket
pnpm exec playwright test tests/e2e/exploratory/ --reporter=list
```

Screenshots for failed tests live under `test-results/` and `tests/e2e/exploratory/screenshots/responsive/` (mobile renderings at 390/412/768 px).

## Priority legend

- **P0** — blocks submission gate or data integrity / security
- **P1** — user-visible broken flow or clear a11y failure (must-fix before judging)
- **P2** — polish / usability / edge case
- **P3** — nit / cosmetic

---

## P1 — ACCESSIBILITY

### [P1 · A11Y-01] `/login`, `/register`, `/forgot-password` have **zero** headings

**Evidence:** [01-a11y-audit.spec.ts:44](./01-a11y-audit.spec.ts#L44) — `h1-h6` count = 0 on all three auth pages.

**Root cause:** [apps/web/src/components/ui/card.tsx:26](../../../apps/web/src/components/ui/card.tsx#L26) — `CardTitle` renders as `<div>`, not `<h1>` / `<h2>`. Upstream shadcn has since switched `CardTitle` to `<h3>`; we're on an older copy.

**Impact:** Screen reader users navigating by heading skip these pages entirely. Tab-by-heading in NVDA/VoiceOver lands on nothing.

**Fix:** Change `CardTitle` to render `<h2>` (or accept a polymorphic `as` prop) and audit all uses. Or, faster: add an explicit `<h1>` above each auth card.

---

### [P1 · A11Y-02] Authenticated routes `/settings/password`, `/settings/sessions`, `/settings/account` have **zero** headings

**Evidence:** [01-a11y-audit.spec.ts:57](./01-a11y-audit.spec.ts#L57) + live snapshot `/settings/password` — "Change password" renders as generic `<div>`.

Same underlying bug as A11Y-01 (CardTitle is a div). Fixing CardTitle cures every settings page in one hit.

---

### [P1 · A11Y-03] Settings: `revokeOtherSessions` checkbox has no label association

**Evidence:** [01-a11y-audit.spec.ts:105](./01-a11y-audit.spec.ts#L105) — unlabelled `<input type="checkbox" name="revokeOtherSessions">` on `/settings/password`. No `htmlFor`, no `aria-label`, no wrapping `<label>`.

**Impact:** Keyboard + screen reader users can't tell what the checkbox does. Click-targets for the visual label (if any) don't toggle state.

**Fix:** Wrap the checkbox in `<label>…</label>` or attach `<Label htmlFor="revokeOtherSessions">` like the Email/Password inputs do.

---

### [P1 · A11Y-04] Mobile: `/rooms` horizontal overflow at 390 px and 412 px viewports

**Evidence:** [04-responsive.spec.ts:62](./04-responsive.spec.ts#L62). `docWidth=668, viewport=390` on iPhone 12 and `viewport=412` on Pixel 7. Forces horizontal scrolling on every phone.

Screenshots: `tests/e2e/exploratory/screenshots/responsive/rooms-iphone12.png`, `rooms-pixel7.png`.

**Impact:** The "Your rooms" list is clipped. Every mobile user starts with a misaligned layout. Judging on a phone will see this in the first 10 seconds.

**Fix candidates:** the header flex row or the rooms-list card probably has a fixed `min-w-*` or a Tailwind `w-[Npx]` that's too wide. Inspect `apps/web/src/app/rooms/page.tsx` + its header component. `/rooms/general` and `/login` fit — this is a `/rooms` regression.

---

### [P1 · A11Y-05] Form validation errors: inputs don't wire `aria-invalid` or `aria-describedby`

**Evidence:** [01-a11y-audit.spec.ts:71](./01-a11y-audit.spec.ts#L71). After submitting an empty `/login`, the inputs show visible error text but carry none of the ARIA state.

```text
email:    aria-invalid=null, aria-describedby=null
password: aria-invalid=null, aria-describedby=null
```

**Impact:** A screen reader user submitting an empty form gets no announcement that the submit failed, and no way to discover the error from the field.

**Fix:** In each `<Input>` where an error can render, set `aria-invalid={Boolean(errors.<field>)}` and give the error `<p>` an `id` that the input's `aria-describedby` points at.

---

## P1 — PERFORMANCE

### [P1 · PERF-01] Room members sidebar renders all 2,969 users into the DOM

**Evidence:** [06-members-perf.spec.ts:18](./06-members-perf.spec.ts#L18). On `/rooms/general`:

- `memberItems = 2969`
- `document.querySelectorAll('*').length = 89264`

**Impact:**

- ~90k DOM nodes per room view — mobile scroll stutters; memory climbs fast as you navigate rooms.
- Scroll jitter verified in spec #2 (longtasks > 50 ms observed during 2.5 s scroll window).
- Sidebar search/filter will slow linearly.

**Fix:** Virtualise with `react-virtuoso` (or `react-window`), or paginate the members list via a "Load more" with an initial window of ~50. Server already has a count — expose a `GET /rooms/:id/members?cursor=` endpoint if not already.

**Context:** 2,969 is the seeded user count, not a normal room — but the hackathon judges will walk through with this seeded state. This is the first impression performance story.

---

## P2 — UX / COPY

### [P2 · UX-01] Raw zod error message leaks to users on `/login`

**Evidence:** [01-a11y-audit.spec.ts:90](./01-a11y-audit.spec.ts#L90). Submitting empty password surfaces:

> "Too small: expected string to have >=1 characters"

**Impact:** Reads like a developer trace; not what a real user expects to see for "your password is empty".

**Fix:** Either set a `.min(1, { message: "Password is required" })` override in the shared zod schema, or map error codes to copy in the login form's `describeValidationError(...)` helper.

---

### [P2 · UX-02] Composer loses focus after Enter-to-send

**Evidence:** [05-keyboard-nav.spec.ts:67](./05-keyboard-nav.spec.ts#L67) — `activeElement` is `BODY` after `send()` resolves.

**Impact:** The user has to click / tab back into the composer to send a second message. Breaks rapid-reply UX which is the point of a chat app.

**Fix:** In `MessageComposer.send()` (apps/web/src/components/chat/MessageComposer.tsx:184) refocus `textareaRef.current` after the state resets. One `requestAnimationFrame(() => textareaRef.current?.focus())` after `setValue("")` should do it.

---

### [P2 · UX-03] Own presence badge shows `offline` while actively signed in

**Evidence:** Playwright MCP exploratory snapshot — the header chip for `@alice` persistently reads `offline` on every page I visited, including the one I just typed in. Admin page confirms: "Online users: 0" while one user is active.

**Impact:** Tells the user they aren't connected when they are. Erodes trust in the realtime experience.

**Fix: triage in S2 presence code.** The client's own user-id subscription may be missing from the presence feed, or the self-heartbeat hasn't ticked yet on first render. Minimum: hide the badge until the first heartbeat, or label it `connecting…` during that gap.

---

### [P2 · UX-04] No skip-to-main link on authenticated layout

**Evidence:** [05-keyboard-nav.spec.ts:36](./05-keyboard-nav.spec.ts#L36). First `Tab` press lands on nothing (or the first sidebar link) — no skip link.

**Impact:** Keyboard users have to tab past the entire top bar + sidebar every page load to reach the composer.

**Fix:** Add a visually hidden `<a href="#main">Skip to main content</a>` as the first focusable element in the app layout, and add `id="main"` to the `<main>` element.

---

### [P2 · UX-05] `AI Herders Chat` brand text in header is not a link

**Evidence:** Playwright MCP snapshot — `generic [ref=e5]: AI Herders Chat`. No anchor role, no href.

**Impact:** Standard web reflex is to click the logo to go home. Every user will try once.

**Fix:** Wrap in `<Link href="/rooms">` and keep the visual styling.

---

### [P2 · UX-06] Login/register cross-links use `<a href>` instead of `<Link>`

**Evidence:** [apps/web/src/app/login/page.tsx:82](../../../apps/web/src/app/login/page.tsx#L82) — "Create one" link; same pattern at `register/page.tsx:104`.

**Impact:** Full page reload on every auth-page swap. Visible flash; wasted SSR.

**Fix:** Import `Link` from `next/link` and replace the raw `<a>`.

---

### [P1 · UX-08] Message rate-limit drops messages **silently** with no user feedback

**Evidence:** [03-chat-message-edge-cases.spec.ts — rapid burst test](./03-chat-message-edge-cases.spec.ts). Bursting 10 messages through the composer, some land and some don't — no toast, no inline error, no greyed state. Just lost messages.

**Suspected source:** Fastify per-IP or per-user rate-limit bucket on message POST. REQ-062 / REQ-009 family.

**Impact:** User types, sends, sees nothing happen, sends again. Every dropped message compounds the confusion. At load (300-user target) this makes the UI feel broken.

**Fix:**

1. The backend already returns a 429 — the web client must surface it. Wrap `onSend()` in `RoomClient.tsx` to catch and toast "Slow down — message rate limit reached" (or equivalent).
2. Optional: grey the composer briefly and announce the recovery window (e.g. "sending again in 3s").

---

### [P2 · UX-07] `/rooms/general`: message list has no list semantics

**Evidence:** Playwright MCP DOM probe — `messageCandidates = 0`, no `role="log"`, no `role="listitem"`, no `[data-message-id]`. Messages render as nested `<div>`s.

**Impact:**

- Screen readers can't announce "new message from Bob" unless we add a live region.
- Keyboard users have no "next message" affordance.
- Test selectors have to use text matching (as `s1-demo.spec.ts` comments already note).

**Fix:**

1. Wrap the message scroll container in `<ol role="log" aria-live="polite" aria-relevant="additions text">`.
2. Each row: `<li role="listitem" data-message-id={id}>…</li>`.

Side benefit: existing specs become less brittle.

---

## P2 — EDGE CASES

### [P2 · EDGE-01] Whitespace-only submit: composer clears but may momentarily flash a row

**Evidence:** [03-chat-message-edge-cases.spec.ts](./03-chat-message-edge-cases.spec.ts). Composer's own `canSend` gate does block sends when `trimmed.length === 0`, so no network call. But my initial heuristic caught an ephemeral empty element; the refined anchor-based assertion passes. **No real data bug** — but investigate whether the auto-sizing textarea briefly renders a zero-height row in the messages feed during send retries.

---

### [P2 · EDGE-02] Huge message (10k chars) silent client-side cap

**Evidence:** [MessageComposer.tsx:9](../../../apps/web/src/components/chat/MessageComposer.tsx#L9) — `MAX_BYTES = 3072`. Above that the Send button disables, and `Enter` no-ops via the `canSend` check — but the **user gets no explicit "too long" toast**, the button just greys out.

**Fix:** When `bytes > MAX_BYTES` show an inline error ("Message too long — max 3,000 characters") under the textarea, not just the counter in red.

---

## P3 — COSMETIC

### [P3 · POLISH-01] `/favicon.ico` 404 on every page

**Evidence:** Every Playwright session logs `404 /favicon.ico`. Not a bug, just noise.

**Fix:** Drop a 32×32 ICO (or PNG) at `apps/web/public/favicon.ico`. Bonus: add `<link rel="icon">` with a branded colour.

---

### [P3 · POLISH-02] "Primary" nav contains only "Contacts"

**Evidence:** Snapshot of `banner > navigation "Primary"` shows a single link.

If "Rooms" is intentionally implicit (since you're always there), consider: put "Rooms" back in primary nav; rename the landmark to "Utilities"; or collapse the whole chip into a top-level menu. Right now the nav landmark exists mostly for screen readers' sake and delivers one item.

---

### [P3 · POLISH-03] `aria-hidden` ghost textarea is expected — no action

Observation only — `react-textarea-autosize` mounts a hidden measurement textarea in `<body>`. Initially flagged by my a11y sweep as an unlabelled input; it has `aria-hidden="true"` and `tabindex="-1"`, so assistive tech correctly ignores it. I've noted so the next exploratory pass doesn't re-flag it. The spec in `01-a11y-audit.spec.ts` will be tightened to skip `aria-hidden` inputs in the next iteration.

---

## What's PASSING (worth knowing)

These exploratory checks returned green — credit where due:

- **XSS:** The composer escapes `<script>` / `<img onerror>` payloads; text renders verbatim and no inline code executes. Confirmed via `window.__xss` side-effect probe.
- **Shift+Enter vs Enter:** Correct. Newline on shift-modified, send on plain.
- **Rapid burst of 10 messages:** All render in order and remain visible.
- **`/login?next=…` same-origin:** Honoured; redirects to `/rooms/general` as specified.
- **`/login?next=https://evil.example/…` off-origin:** Rejected; stays on localhost.
- **Login success path:** Seeded credentials sign in cleanly; no retry needed.
- **`/rooms/browse`, `/contacts`, `/admin`, `/rooms`:** All have a proper `<h1>`. The bug is isolated to pages that rely on `CardTitle`.
- **Composer on mobile:** Remains above the fold at 390/412/768 px. Room view layout is mobile-safe, unlike `/rooms` list.
- **Empty and blank-only submits:** No network call made (client-side guard is solid). Ephemeral DOM artefacts may still deserve a look (EDGE-01).
- **Console + failed requests:** Clean beyond the known favicon 404. No runtime React errors, no failed API calls on the key routes. (See [07-console-errors.spec.ts](./07-console-errors.spec.ts) run output.)
- **Byte counter accessibility:** `aria-live="polite"` + `aria-hidden` when under the warn threshold — genuinely tasteful.

---

## Suggested prioritisation (for the morning)

1. **CardTitle → `<h2>`** — one-line fix in a shared component cures A11Y-01 and A11Y-02 together (most pages).
2. **Members-list virtualisation** — biggest perf win; every mobile user will feel this. PERF-01.
3. **`/rooms` mobile overflow** — A11Y-04, first impression on phones.
4. **Composer refocus after send** — UX-02, 3-line fix, dramatic quality-of-life improvement.
5. **aria-invalid + describedby wiring** — A11Y-05, one pass across `<Input>` consumers.
6. **Zod error copy** — UX-01, trivial schema tweak.
7. **Make header brand a link + swap raw `<a>` for `<Link>`** — UX-05, UX-06, small polish, fast.
8. **Revisit own-presence badge** — UX-03, probably a one-liner once the root cause is identified.

Everything after that is P2/P3 and fits a follow-up pass.

## What I did NOT cover

I ran out of cold exploration before these; queue for the next pass:

- Forgot-password → reset-password round trip with a real token (needs mailbox probe or seeded token).
- DM surface. I saw contacts tabs but didn't create/accept a friend request and open a DM.
- File upload/download happy path. I read the composer's upload guard but didn't exercise a drag-and-drop or paperclip click.
- Admin moderation actions (mute / delete / ban) with a real message.
- Socket disconnect → reconnect → gap-fill. `docs/adr/0003-watermark-protocol.md` promises backfill; worth a network-offline spec.
- Multi-language / IME input. The `nativeEvent.isComposing` guard exists; worth stress-testing.
- CSRF + cookie-jar behaviour across origins.

These are candidate specs for a `09-*` – `14-*` follow-up set.
