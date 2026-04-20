# 2026-04-20 — Test flake + dual-browser Playwright sweep

Two-track tech-debt sweep ahead of any further feature work. Both tracks branch from `AI-dev` (tip `edd8a6b`) into isolated worktrees under `hackathon-starter-public/.worktrees/`, both commit autonomously on their own feature branches per `feedback-own-branch-commits-preauthorized`, and both stop-and-report rather than resolve conflicts with the concurrent `feat/ui-polish-chat` UI agent.

## Context

Three FOLLOWUPS entries are the scope:

1. **Parallel-fork backend test flake** ([FOLLOWUPS.md:137](../FOLLOWUPS.md)) — `rooms-create`, `attachments-upload`, `rooms-join-rate-limit` pass solo but sometimes fail full-suite. Matches `feedback-vitest-one-buildapp` signature (multiple `buildApp()` calls racing better-auth init).
2. **Backend parallel-DB FK race residual** ([FOLLOWUPS.md:24](../FOLLOWUPS.md)) — 1–11 tests flaky on ~1/4 full runs after the `auth.ts customRules` test-mode fix. Same root-cause family as #1 per FOLLOWUPS analysis; treat as one investigation.
3. **Dual-browser Playwright not wired** — multiple FOLLOWUPS entries. Specs use `browser.newContext()` twice on the same Chromium, which shares a cookie jar and can mask cross-identity bugs per `feedback-playwright-multi-user`.

## Tracks

### Track A — Backend test flake

- **Worktree:** `hackathon-starter-public/.worktrees/fix-backend-flake/`
- **Branch:** `fix/backend-test-flake` (from `AI-dev@edd8a6b`)
- **Scope:** Root-cause and fix items 1+2 as one investigation — they're the same family per FOLLOWUPS:24's "residual, not a regression" analysis.
- **Starting hypothesis:** multiple describe-scoped `buildApp()` calls race better-auth init. Sign-up returns 200 but writes no user row, downstream INSERTs surface as FK-looking 404s. Already-shipped fix (`customRules["/sign-up/email"]` function form returning 10000 in test mode, plus `registerRateLimitGuard` short-circuit in `app.ts`) addressed the rate-limit bucket bleed but not the init race.
- **Probable fix surface:** `apps/backend/tests/setup.ts`, `apps/backend/vitest.config.ts`, buildApp lifecycle, possibly the three flaky files' describe-block structure. Exact shape TBD by the agent.
- **Do-not-touch:** `apps/backend/src/routes/rooms.ts`, `apps/backend/src/routes/attachments.ts` — on the DO-NOT-EDIT boundary list per the existing FOLLOWUPS entry.
- **Acceptance:** `pnpm --filter backend test:run` green 3 runs in a row, root-cause written to FOLLOWUPS update.

### Track B — Dual-browser Playwright (two-phase)

- **Worktree:** `hackathon-starter-public/.worktrees/pw-dual-browser/`
- **Branch:** `feat/playwright-dual-browser` (from `AI-dev@edd8a6b`)
- **Isolation strategy:** Separate docker stack via `docker compose -p firefox-e2e` using a new `docker-compose.e2e.yml` override that remaps ports with +100 offset (web :3100, backend :4100, postgres :55432, redis :56379). This avoids contention with the UI agent's stack on :3000/:4000/:5432/:6379.

**Phase 1 (Z1) — prove the mechanism:**

1. Add `firefox` project to [playwright.config.ts](../../playwright.config.ts) alongside existing `chromium`.
2. Parameterize `baseURL` via `PLAYWRIGHT_BASE_URL` env var (default `http://localhost:3000` so current callers unaffected).
3. Create `docker-compose.e2e.yml` override (ports +100, shared `SESSION_SECRET`).
4. Convert the two `browser.newContext()` calls in [tests/e2e/s2-invitations.spec.ts](../../tests/e2e/s2-invitations.spec.ts) (L100-101 and L156-157) — second context becomes a real Firefox instance via `firefox.launch()`.
5. Bring up isolated stack: `docker compose -p firefox-e2e -f docker-compose.yml -f docker-compose.e2e.yml up --build -d`.
6. Run `PLAYWRIGHT_BASE_URL=http://localhost:3100 pnpm test:e2e --project=firefox -g "REQ-089"`.
7. **CHECKPOINT:** report back green-or-red before Phase 2.

**Phase 2 (Z2) — fan out (only after Z1 green):**

Convert remaining dual-browser candidates, run full firefox suite, confirm green:

- `tests/e2e/s2-invitations-decline.spec.ts`
- `tests/e2e/s2-admin-delete.spec.ts`
- `tests/e2e/s2-attach-button.spec.ts`
- `tests/e2e/s2-moderation.spec.ts` (REQ-208 dual-socket force-leave)
- `tests/e2e/s2-sessions.spec.ts`
- Any others surfaced during Phase 1.

Firefox already installed via `npx playwright install firefox`; agent must NOT re-install.

## Coordination with UI agent

The `feat/ui-polish-chat` worktree is active and may merge to `AI-dev` before either track finishes.

- Both tracks branch from current `AI-dev` tip and do NOT `git pull` or `git merge AI-dev` during work.
- When main session merges Track A/B back: per `feedback-merge-sop`, ff-only if ancestor, `--no-ff` if diverged, never rebase.
- Collision surfaces:
  - Track A touches `apps/backend/tests/**`, `apps/backend/vitest.config.ts`, possibly `apps/backend/src/app.ts` — UI agent almost certainly doesn't touch these, likely ff merge.
  - Track B touches `playwright.config.ts` (small risk), `tests/e2e/*.spec.ts` (small risk if UI agent adds polish regression specs), and `docker-compose.e2e.yml` (new file, zero risk).
- Agents stop-and-report on any conflict or diverged state; main session handles resolution.

## Done signals

| Track | Signal |
|---|---|
| A | `pnpm --filter backend test:run` green 3×, root-cause paragraph, commit hash |
| B Phase 1 | `--project=firefox -g "REQ-089"` green on isolated stack, commit hash, checkpoint message |
| B Phase 2 | Full firefox suite green, N specs converted, commit hash |

## Out of scope

- Chromium project changes (UI agent territory).
- Test infrastructure refactors beyond what the fixes require.
- Wiring firefox into CI — that's a follow-up once the shape is proven locally.
- Docker-compose changes to the submission-gate file itself; all isolation lives in the override.
