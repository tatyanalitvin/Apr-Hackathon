# Spec: REQ-006 — Password policy (12-char minimum + top-10k blocklist)

**Status**: approved (2026-04-20, post 3-agent review)
**Branch**: `feat/req-006-password-policy`
**Owner (human)**: Tatiana
**Owner (agent)**: Claude Code Opus 4.7
**Closes**: [docs/FOLLOWUPS.md](../FOLLOWUPS.md) item #3 under "ADR-0006 deviations"

## 1. Why

REQ-006 in the v4 catalog is a registration-time password guard against two cheap-credential attacks: brute-force of short passwords and credential-stuffing against well-known common passwords. The rule is spelled out at [task/Chat_Server_Requirements_v4.md:116-118](../../../task/Chat_Server_Requirements_v4.md):

> Password MUST be 12–128 bytes UTF-8. It MUST NOT be in the top-10,000-common-passwords list bundled as `/apps/server/src/assets/common-passwords.txt` (source: SecLists).
> Acceptance: `password1234` fails `password_common`; `short` fails `password_too_short`; a random 16-char string passes.

This is the last server-side REQ in the S1 auth block still open on the FOLLOWUPS tracker. All the fixture churn it causes (~30+ Supertest call sites) must land in lockstep — the REQ itself is trivial but the sweep is what makes it a dedicated branch rather than a drive-by.

## 2. Non-goals

- **No client-side blocklist check.** The 100 KB asset does not ship to the browser; the zod schema in `packages/shared/src/dto.ts` only enforces length. Common-password rejection is server-only. UI surfaces the server error via the existing `{error:"validation", issues:[...]}` handler.
- **No password-strength meter.** Not a v4 requirement. Deferred entirely.
- **No rehashing or migration of existing accounts.** REQ-006 is a registration-time check; existing users keep their passwords. (The project has no production users — this is theoretical but worth stating.)
- **No password rotation / expiry.** Not in v4.
- **No argon2id swap.** REQ-008 deviation is tracked separately in ADR-0009.

## 3. User stories

- As a new user signing up, if I type a password shorter than 12 bytes, the server rejects me with a clear `password_too_short` code so my UI can show "at least 12 characters".
- As a new user, if I pick `password1234` or any top-10k common password, the server rejects me with `password_common` so I know to pick something unique.
- As a maintainer, fixture passwords across the backend test suite do NOT appear on the SecLists top-10k list, so REQ-006 enforcement cannot retroactively break unrelated tests.

## 4. Requirements (testable)

- [ ] **R1 — length floor (shape).** `POST /api/auth/sign-up/email` with `password` < 12 bytes returns 400 with the existing `{error:"validation", issues:[{path:["password"], …}]}` shape and the issue message starts with `password_too_short`. Enforced by zod `.min(12)` in `packages/shared/src/dto.ts` so the browser form can preview-validate too.
- [ ] **R2 — length ceiling (shape).** Passwords > 128 bytes UTF-8 return 400 with `password_too_long` on the `password` path. (The current schema caps at 256 as a DoS guard; REQ-006 tightens to 128 to match v3.docx §2.1 exactly. `.max(128)` replaces `.max(256)`.)
- [ ] **R3 — blocklist reject.** After the zod guard passes, a second `passwordPolicyGuard` preHandler in [apps/backend/src/app.ts](../../apps/backend/src/app.ts) checks an in-memory `Set<string>` built from `apps/backend/src/assets/common-passwords.txt`. A hit returns 400 with message beginning `password_common` on `path:["password"]`, same envelope as zodBodyGuard. Lowercase-match on both sides (SecLists is lowercase; user input is lowercased before Set lookup) so that `Password1234`, `PASSWORD1234`, and `password1234` all resolve to the same blocklist entry — closing the trivial case-variant bypass. Rationale in §5.
- [ ] **R4 — random 16-char passes.** A cryptographically-random 16-char alphanumeric+symbol string proceeds past both guards (status 200 from better-auth sign-up).
- [ ] **R5 — asset ships in docker image.** `apps/backend/src/assets/common-passwords.txt` is checked into git and copied into the backend Docker image (Dockerfile already does `COPY . .` at line 19, so this is a no-op verification — just confirm via `docker compose up` smoke after the branch lands).
- [ ] **R6 — fixture sweep.** No backend test file uses `"password1234"` after this branch lands. Current state (verified by exploration): 139 occurrences across 102 files in `apps/backend/tests/**`, all in Supertest `.send()` bodies (zero assertion-context hits, so mass-replace is mechanical). Replaced by import of `TEST_PASSWORD_OK` from a new `apps/backend/tests/helpers/fixtures.ts`. Running `grep -r 'password1234' apps/backend/tests` returns zero hits after the sweep.
- [ ] **R7 — backend boot fails loud if blocklist asset missing.** If `common-passwords.txt` is absent or empty, the loader throws at module-import time (before `buildApp()` returns). This prevents a silent "everything passes the blocklist" regression. Covered by the loader's own unit test (§6 Task 2).
- [ ] **R8 — blocklist is loaded once.** The `Set<string>` is module-scoped and populated at first import (not per `buildApp()`, not per request). Re-opening/re-reading on each sign-up would add a file syscall to the hot path. Note: compatible with the "one buildApp per Vitest file" memory — module-level IO fires once per worker process, orthogonal to better-auth init races.
- [ ] **R9 — `TEST_PASSWORD_OK` is NOT on the blocklist.** The fixture password exported from `apps/backend/tests/helpers/fixtures.ts` is asserted as a non-member of the loaded blocklist in a unit test. Guards against the exact story-#3 regression: a future blocklist refresh that accidentally includes the test fixture would silently break the entire suite.

## 5. Design notes

- **Data model changes:** none.
- **New API endpoints:** none. Extends existing `POST /api/auth/sign-up/email`.
- **New UI routes:** none.
- **External services touched:** none at runtime. SecLists top-10k list is a one-time download pulled in by hand + committed (not a build-time dependency, to keep `docker compose up` offline-safe — matches the "submission gate" constraint in CLAUDE.md).
- **Asset source:** SecLists `10-million-password-list-top-10000.txt` from [github.com/danielmiessler/SecLists](https://github.com/danielmiessler/SecLists/blob/master/Passwords/Common-Credentials/10-million-password-list-top-10000.txt). Attribution lives in a header comment in a small loader module, not in the .txt itself (to keep the raw file byte-identical to source).
- **Layering decision — why a second preHandler and not zod `.superRefine`:** `packages/shared/src/dto.ts` is consumed by the web frontend. Bundling a 100 KB blocklist Set into the client bundle is wasteful, and `node:fs` doesn't exist in the browser. So shared owns the length check (universal) and backend owns the blocklist check (server-only). Preceded by the existing `registerRateLimitGuard` (REQ-009 /24 CIDR) → then `zodBodyGuard(registerSchema)` → then new `passwordPolicyGuard` → then `proxyToBetterAuth`. Same error envelope at all three layers.
- **Web form auto-picks up new zod messages.** [apps/web/src/app/register/page.tsx](../../apps/web/src/app/register/page.tsx) at line 24 wires `zodResolver(registerSchema)` into React Hook Form and renders errors verbatim from `form.formState.errors.password.message`. Bumping `.min` / `.max` in shared propagates the new `password_too_short` / `password_too_long` messages to the UI without any web-side code change. `password_common` only surfaces server-side (by design — no blocklist in the client bundle); the existing server-error handler already pipes `{error:"validation", issues:[...]}` into the form's error display, so no UI work is needed.
- **Why lowercase-match on both sides:** SecLists is lowercase. A case-sensitive match means `Password1234` (trivial case variant of the #1 blocklist entry) passes — effectively making the blocklist useless against any attacker with a shift key. Collapsing case-variants into one hit does NOT reduce the entropy of *accepted* passwords; it only reduces the entropy of *rejected* ones, which is exactly what we want. Lowercasing the user input before the Set lookup is the right call. Documented in the loader module.
- **Security/auth:** closes a v3.docx §8 threat-model gap. Doesn't interact with REQ-008 (scrypt vs argon2id — ADR-0009 deviation).
- **Fixture replacement password:** `TEST_PASSWORD_OK` = `"Hackaton_Test_Pw_2026!"` (22 chars, mixed case, digit, symbol, not in SecLists top-10k — I'll grep-verify against the committed file). Lives in a new file `apps/backend/tests/helpers/fixtures.ts` exported as a named constant so the eventual cleanup is a rename, not a re-swap.

## 6. Tasks (each <2h, commit at stage boundary per CLAUDE.md §3)

TDD discipline: `src/lib/` code gets a failing unit test first. API-level guard behaviour gets a failing integration test first. The asset + schema-shape bump are the ONLY non-TDD steps (they're data/config, not logic).

1. [x] **Asset.** Downloaded SecLists `Pwdb_top-10000.txt` → `apps/backend/src/assets/common-passwords.txt` (10 000 lines, 80 456 bytes). List-selection note: v3.docx §8 referred to `10-million-password-list-top-10000.txt` — that file was renamed upstream to `xato-net-10-million-passwords-10000.txt`, but the renamed file does NOT include `password1234` (only `password1`, `password2`, `password9`), so it fails the v4 acceptance test literally. `Pwdb_top-10000.txt` is the right-sized SecLists list that DOES include `password1234`, matching the v4 acceptance test. Attribution: SecLists, MIT, commit pinned by URL in the loader comment. Fixture verification (pass): `password1234` ON-list (v4 acceptance), `hunter2hunter2` OFF-list (seed script), `hackaton_test_pw_2026!` OFF-list (`TEST_PASSWORD_OK`).
2. [ ] **Loader — TDD.** Write `apps/backend/src/lib/password-blocklist.test.ts` (colocated with the module, matching `register-rate-limit.test.ts` convention) FIRST covering: (a) empty-file throw (R7), (b) case-variant hit (`Password1234` lowercases and matches the committed asset), (c) random 16-char string miss, (d) loaded set has 10 000 entries, (e) `TEST_PASSWORD_OK` miss (R9 unit-side, before the fixtures helper exists — inline the literal for now, import later from helpers when it's created in Task 6). Commit red. Then implement `apps/backend/src/lib/password-blocklist.ts`: module-top-level `fs.readFileSync` of `../assets/common-passwords.txt`, `Set<string>` of lowercased entries, exports `isCommonPassword(pw: string): boolean` that lowercases input before lookup. Throws on missing/empty file. SecLists MIT attribution in the file header. Commit green.
3. [ ] **Zod shape bump.** Update `packages/shared/src/dto.ts::registerSchema.password` from `.min(8).max(256)` to `.min(12, "password_too_short: ...").max(128, "password_too_long: ...")`. Verify `pnpm --filter shared test:run` (if any) + `pnpm typecheck`. Commit.
4. [ ] **Guard — TDD (failing tests red).** In `apps/backend/tests/register-validation.test.ts`, add a new `describe("REQ-006 password policy", ...)` block covering: R1 (password < 12 → `password_too_short`), R2 (password > 128 → `password_too_long`), R3 (`password1234` → `password_common`), R4 (random 16-char alphanumeric+symbol → 200), R9 (`TEST_PASSWORD_OK` passes `isCommonPassword` false at import time — unit test, not HTTP). Run and confirm red. Commit.
5. [ ] **Guard — implement green.** Add `passwordPolicyGuard` preHandler in `apps/backend/src/app.ts`, wired between `zodBodyGuard(registerSchema)` and `proxyToBetterAuth` on the `/api/auth/sign-up/email` route. Error envelope matches `zodBodyGuard`: `{error:"validation", issues:[{path:["password"], message:"password_common: ...", code:"custom"}]}`. Run Task 4's describe block → green. Commit.
6. [ ] **Fixture sweep (separate commit).** Create `apps/backend/tests/helpers/fixtures.ts` exporting `TEST_PASSWORD_OK = "Hackaton_Test_Pw_2026!"`. Mass-replace the 139 `"password1234"` occurrences across 102 test files with `TEST_PASSWORD_OK` + import. Verify `grep -r 'password1234' apps/backend/tests` returns zero. Commit.
7. [ ] **Full-suite + docker smoke + FOLLOWUPS.** Flush Redis, run `pnpm --filter backend test:run` (expect all green; pre-existing 4 rate-limit flakes are a flush issue, not a REQ-006 issue). Run `pnpm typecheck`. Then the submission-gate check: `docker compose up -d --build backend`, `curl -f http://localhost:4000/health`, and spot-check `docker compose exec backend ls src/assets/common-passwords.txt` to confirm the asset made it into the image (R5). Tear down. Update [docs/FOLLOWUPS.md](../FOLLOWUPS.md) item #3 to strikethrough + shipped-commit-SHA. Commit.

**Post-merge note (on rebase / merge-to-main):** re-run `grep -r 'password1234' apps/backend/tests` once more. Sibling worktree branches may have added new fixtures using the blocklisted literal after this branch's grep — any hit is a parallel-branch fixture to sweep before the merge closes.

## 7. Out of scope / follow-ups

- **UI copy for `password_common`** — the existing register form already renders zod-issue `message` verbatim; no copy tweak needed for MVP. If we want a prettier "try something less common" prompt, that's a separate ticket.
- **E2E Playwright coverage** — REQ-006 is exercised by integration tests through the real sign-up route; adding a Playwright spec is belt-and-suspenders. Deferred.
- **Expanding blocklist beyond top-10k** — SecLists has a top-1M list; v4 is explicit about 10k. No action.

## 8. Resolved questions (closed during spec review, 2026-04-20)

- [x] **License / attribution.** SecLists is MIT. Inline credit in the loader module (`apps/backend/src/lib/password-blocklist.ts`) is sufficient; no separate NOTICE file. Matches how other third-party-sourced content is credited in this repo.
- [x] **Seed script.** Verified via grep: `scripts/seed.ts:63` uses `PASSWORD = "hunter2hunter2"` (12 chars, mixed-case safe, not on SecLists top-10k — to be re-confirmed against the asset in Task 1). No other seed/infra files use `password1234`. R6 sweep reduces to `apps/backend/tests/**` only (139 occurrences across 102 files).
