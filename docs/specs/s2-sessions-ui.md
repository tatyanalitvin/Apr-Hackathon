# Spec: Active Sessions UI (s2)

**Status**: approved (2026-04-19)
**Branch**: `feat/sessions-ui`
**Owner (human)**: Tatiana
**Owner (agent)**: Claude Code (Agent D — Wave 1)
**Tracks**: v3.docx §2.2.4 Active Sessions (REQ-017 list, REQ-018 revoke)
**Brief**: `docs/briefs/wave1-sessions.md`

## 1. Why

Signed-in users need to see where they're logged in (which browser/IP) and forcibly end sessions they don't recognise or no longer want (shared laptop, lost phone). Backend already exposes the data (`GET /api/v1/sessions`) and a revoke endpoint (`DELETE /api/v1/sessions/:id`); what's missing is the user-facing surface.

The route `/settings/sessions` sits beside the existing `/settings/password` and `/settings/account` pages in the already-wired settings cluster — the Header's right-side button cluster only needs a single new link.

## 2. Non-goals

- No backend changes. Route, contract, and tests at `apps/backend/src/routes/sessions.ts` are frozen.
- No session metadata enrichment (geo-IP, device fingerprinting, login history).
- No bulk "sign out everywhere" button. The user revokes rows one at a time; the "delete account" flow already handles the nuclear option.
- No real-time push. Rows refetch on mount and after a successful revoke; we don't subscribe to a socket channel for session changes.
- No custom UA-parsing library (ua-parser-js et al.). A tiny inline helper is fine; readability over fidelity.

## 3. User stories

- As a signed-in user, I can open `/settings/sessions` and see every active session on my account with browser, IP, last-active and created timestamps, so I can spot rogue logins.
- As a signed-in user, I can click "Sign out" on any row that is not my current browser and that session is invalidated immediately, so I can kick a stale device without changing my password.
- As a signed-in user, I can click "Sign out this browser" on the row tagged as current and I'm sent back to `/login`, so I can cleanly end the local session.
- As a signed-in user reaching `/settings/sessions` unauthenticated, I am redirected to `/login?next=/settings/sessions`, so my intent isn't lost.

## 4. Requirements (testable)

Each requirement is observable by a dual-browser manual smoke or a Vitest/Playwright test.

- [ ] **R1** Unauthed visit to `/settings/sessions` redirects to `/login?next=%2Fsettings%2Fsessions` (RequireSession behaviour; already covered by the wrapper).
- [ ] **R2** Authed visit renders a table with columns `Browser | IP | Last active | Created | Status | Action` and one row per session returned by `GET /api/v1/sessions`.
- [ ] **R3** The row whose backend payload has `current: true` is tagged with a "This browser" pill in the Status column; other rows' Status is blank.
- [ ] **R4** The row with `current: true` shows action label "Sign out this browser"; others show "Sign out".
- [ ] **R5** Clicking "Sign out" on a non-current row fires `DELETE /api/v1/sessions/:id`, optimistically removes the row from the list, shows a success toast, and refetches to reconcile.
- [ ] **R6** Clicking "Sign out this browser" fires `DELETE /api/v1/sessions/:id` for the current row and on 204 redirects to `/login` (the cookie has been invalidated).
- [ ] **R7** A DELETE that returns 403 (other user's id / bogus id) shows an error toast, leaves the list untouched, and does not redirect. A DELETE that returns 401 (cookie expired between list and DELETE) also surfaces an error toast and leaves the list untouched; the next `useSession()` refresh hands off to `RequireSession`, which redirects to `/login?next=/settings/sessions` on the following render — we do not hand-roll a redirect in the revoke handler.
- [ ] **R8** While the initial list is fetching, a skeleton state is shown (not an empty table flashing).
- [ ] **R9** If `GET /api/v1/sessions` returns only one session (the current browser), the table still renders that row. If somehow it returns zero (shouldn't be possible for an authed caller — but defend), an empty state "No other active sessions" is shown.
- [ ] **R10** The Header's right-side button cluster (inline ghost buttons at `Header.tsx:85-112`) includes a `Sessions` link between `Password` and `Account`, and navigating to it highlights nothing special (no active-nav indicator is defined for the settings cluster).

## 5. Design notes

### Data contract (summary — frozen upstream)

`GET /api/v1/sessions` → `200 Session[]` where

```ts
type Session = {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;   // ISO8601
  updatedAt: string;   // ISO8601 (what we surface as "Last active")
  expiresAt: string;   // ISO8601 (not surfaced in UI for v1, but available)
  current: boolean;
};
```

`DELETE /api/v1/sessions/:id` → `204` on success, `403` on "not yours or doesn't exist", `401` if unauthed. No response body on 204.

Note: `userAgent`/`ipAddress` can be `null` on synthetic sessions (e.g. tests). The UI treats null as "Unknown".

### UI routes

- `/settings/sessions` → new page, gated with `RequireSession` (same pattern as `settings/account/page.tsx`).

### Client helper

New module `apps/web/src/lib/sessions-api.ts`, mirroring the style of `lib/account-api.ts`:

```ts
export type SessionRow = { id; userAgent; ipAddress; createdAt; updatedAt; expiresAt; current };
export async function listSessions(): Promise<SessionRow[]>;      // GET
export async function revokeSession(id: string): Promise<void>;   // DELETE, throws on !ok with message parsed from body
```

Both use `credentials: 'include'` and build URLs off `BACKEND_URL` from `lib/backend.ts`. Error surface is the standard "parsed error message or status code" pattern already in `account-api.ts:41-49`.

### UA parsing

Tiny helper — inline or `lib/ua-parse.ts` — returning a label like `"Chrome on macOS"`, `"Firefox on Windows"`, `"Safari on iOS"`, or falling back to the raw UA substring if nothing matches. Roughly 10 lines, regex-driven, in priority order: Edge before Chrome, Firefox before Safari, Chromium mobile, Firefox mobile, unknown. `null`/empty UA → `"Unknown browser"`.

Extraction to its own file is only justified if we add a Vitest for it; otherwise keep inline per brief's kill-switch #1.

### Header nav link

`apps/web/src/components/chat/Header.tsx` lines 103–108 — the right-side button cluster renders inline ghost buttons (Password, Account, Sign out); no `<DropdownMenu>` exists. Add a `<Button asChild size="sm" variant="ghost"><Link href="/settings/sessions">Sessions</Link></Button>` between the Password button (103–105) and Account button (106–108). Order per brief: Password, Sessions, Account.

### States and interactions

1. **Loading** — full-width `<Skeleton>` block while `listSessions()` is in flight. Show before first successful fetch; not shown on refetch after revoke.
2. **Loaded** — shadcn `<Table>` rendering all rows; current row pinned to top (sort by `current` desc, then `updatedAt` desc).
3. **Empty** — "No other active sessions." Reachable only on R9 edge case; current-session row should always be present, so in practice the table always has ≥1 row.
4. **Error (list)** — if `listSessions` throws, render an inline alert + a retry button that re-calls the fetcher. No toast here; a toast is for transient ops.
5. **Revoke in flight** — action button is disabled and shows "Signing out…" on that row only.
6. **Revoke success (non-current)** — toast success, optimistic filter-out, then `listSessions()` refetch to reconcile (covers the case where another tab also revoked something).
7. **Revoke success (current)** — `router.replace("/login")`. We do NOT reach for a toast here because the redirect is the feedback.
8. **Revoke failure** — toast error with the parsed message, row stays, action button re-enables.

### Security / auth

- All calls go through `credentials: 'include'` cookies. No token is read from JSON (backend strips it on the GET; brief invariant).
- 403 is treated identically for "not yours" and "unknown id" per the backend's probe-oracle block. UI just surfaces "Couldn't sign that session out."
- No session id is embedded in the URL of this page; we refetch the list to get fresh ids every navigation.

## 6. Tasks (UI, test-after per CLAUDE.md step 3)

1. [ ] Scaffold `lib/sessions-api.ts` with `listSessions()` + `revokeSession()` and a `SessionRow` type. No tests required; helpers are thin fetch wrappers.
2. [ ] Scaffold `lib/ua-parse.ts` OR inline helper in page. Decision: inline unless the regex grows past ~15 lines.
3. [ ] Build `app/settings/sessions/page.tsx` wrapped with `RequireSession`. Match the `Header + Card(s) + main` layout used by `settings/account/page.tsx`.
4. [ ] Use shadcn `<Table>` primitives for the list; `<Button>` with `variant="outline"` for Sign out, `variant="ghost"` or `size="sm"` for the current-browser variant so the destructive-looking row-level action doesn't scream.
5. [ ] Add the Header right-side cluster link (single-line edit, lines 103–108).
6. [ ] Manual dual-browser smoke per brief §"Gate criteria" (Chrome + Firefox; confirm 403 on bogus DELETE in devtools).
7. [ ] `pnpm --filter web typecheck` green; `pnpm --filter backend test:run` still green (sanity pass, no backend edits).
8. [ ] Optional — Playwright spec in `tests/e2e/` covering R5 (revoke non-current) and R6 (revoke current → redirect). Time-permitting; kill-switch if >2h remaining budget.

## 7. Out of scope / follow-ups

- "Sign out everywhere except this browser" bulk action — deferred; current delete-account flow covers the hard case.
- Device fingerprinting / geo-IP display — deferred; needs a schema column and a privacy review.
- Real-time invalidation of the list when another tab revokes a session — deferred; 30s-ish staleness window is acceptable for v1, and post-revoke refetch closes the window for the acting tab.
- Session expiry countdown ("expires in 6 days") — data is available on `expiresAt` but not surfaced in v1. Noted as a `// TODO(hackathon):` if the row ever needs it.

## 8. Open questions

- [x] **Q1** (resolved 2026-04-19: yes): Sort `current` first then `updatedAt` desc. Matches Google/GitHub/Slack pattern; action label differs on current row so pinning removes a scan.
- [x] **Q2** (resolved 2026-04-19: no redirect on failure): Toast + stay. If the cookie was already invalid the next interaction hits 401 → RequireSession redirects naturally.
- [x] **Q3** (resolved 2026-04-19: no): Six columns already wide; `expiresAt` without exposing lifetime policy is noise. Deferred to a tooltip if ever asked — see §7.
- [x] **Q4** (resolved 2026-04-19: inline first): Bans on UA libs (§2) + kill-switch #1 + ~10 regex lines don't earn a module. Extract only when the switch crosses ~15 lines or gets a Vitest.
