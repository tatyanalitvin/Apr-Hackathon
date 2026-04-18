# Spec: S1 — Authentication (register, login, sessions)

**Status**: approved (2026-04-18)
**Branch**: `feat/s1-auth`
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code
**Scope**: REQ-001 … REQ-019 (deployment REQ-049 covered by a separate S1 ticket).
**Supersedes**: `docs/specs/auth.md` (pre-pivot, Prisma + argon2 + homemade sessions — will be deleted).

## 1. Why

No other REQ-ID in the brief is reachable without an account. S1 ships the walking skeleton, so auth is the first thing on the critical path: a user must register, sign in, stay signed in across reloads, see which sessions they have, and be able to kill them. Everything else (rooms, messages, realtime) keys off a `session.userId`.

The stack pivot (ADR-0001) settled on `better-auth` so we don't hand-roll password hashing, CSRF, or session rotation under time pressure. This spec codifies exactly which of its features S1 uses and what thin UI/API layer we wrap around it.

## 2. Non-goals

- Email delivery for password reset (REQ-017 endpoint is a stub — SMTP wiring is deferred to S3, see §7).
- Email verification at signup (`requireEmailVerification: false` — called out in §5 so reviewers don't flag it).
- OAuth / SSO / magic-link / social providers.
- Username change workflow (REQ-127 is explicitly out-of-scope for the hackathon — see `docs/BRIEF.md`).
- Account deletion / GDPR export (REQ-126 deferred).
- Admin-side "force logout all users" tooling (not in S1 REQ range).

## 3. User stories

- As Anna, I can register with **email + unique username + display name + password**, so I can start using the chat. (REQ-001, REQ-002, REQ-003, REQ-004, REQ-005)
- As Anna, registration fails clearly if my email or username is already taken, so I know to pick another. (REQ-006, REQ-007)
- As Anna, registration rejects a weak password (<8 chars) or malformed username, so accounts meet the minimum bar. (REQ-008, REQ-009)
- As Anna, I can log in with email + password and a session cookie is set, so subsequent requests are authenticated. (REQ-010, REQ-011)
- As Anna, I can tick "remember me" to extend my session lifetime beyond the default, so I don't have to re-login daily on my own laptop. (REQ-012)
- As Anna, invalid credentials return a generic error and never reveal whether the email exists, so enumeration is impossible. (REQ-013)
- As Anna, repeated failed logins from the same IP start getting rate-limited, so brute-force is throttled. (REQ-014)
- As Anna, I can log out on this browser and the server-side session is revoked, so the cookie alone can't re-auth. (REQ-015, REQ-016)
- As Anna, I can list my active sessions (UA, IP, last-seen) and revoke any of them individually, so I can kick a forgotten session on a shared machine. (REQ-017, REQ-018, v3.docx §2.2.4)
- As Anna, I can request a password-reset link by email (endpoint only — actual send is stubbed, see §7). (REQ-019)

## 4. Requirements (testable)

Every requirement below carries the REQ-ID(s) the `pnpm trace` script will grep for in `tests/`. Test `describe` / `test` names MUST embed these IDs verbatim. Example:

```ts
describe("REQ-006 duplicate email rejected", () => {
  test("REQ-006 returns 4xx and inserts no row", async () => { /* ... */ });
});
```

- [ ] **R1 (REQ-001, REQ-002, REQ-003, REQ-004)**: `POST /api/auth/sign-up/email` with valid `{ email, password, name, username }` creates a `user` row (and the `account` row better-auth uses for the password hash), returns 200 with user payload, and sets a `Set-Cookie` session cookie.
- [ ] **R2 (REQ-005)**: On successful register, the returned cookie authenticates `GET /api/auth/get-session` — user is auto-logged-in.
- [ ] **R3 (REQ-006)**: Registering with an email already present in `user` returns a 4xx error from better-auth that the client surfaces as "email already in use". No duplicate row is inserted.
- [ ] **R4 (REQ-007)**: Registering with a `username` already present in `user.username` returns a 4xx error "username already in use". (Enforced by the unique index on `user.username` + a pre-insert check so better-auth surfaces a clean error rather than a Postgres constraint leak.)
- [ ] **R5 (REQ-008)**: Passwords shorter than 8 chars are rejected client-side (zod `registerSchema`) and server-side (zod at the Fastify boundary **plus** better-auth's minimum). Response is 400 with the zod issue.
- [ ] **R6 (REQ-009)**: Usernames outside `^[A-Za-z0-9_]{3,32}$` are rejected by `usernameSchema` with a 400. Verified by unit tests against the schema and an e2e against the register handler.
- [ ] **R7 (REQ-010, REQ-011)**: `POST /api/auth/sign-in/email` with correct creds returns 200 + session cookie; subsequent `GET /api/auth/get-session` returns the user.
- [ ] **R8 (REQ-012)**: Sign-in with `{ rememberMe: true }` extends `session.expiresAt` to ≥29 days (per the lifetimes pinned in `auth.ts`, task #9) vs. <8 days when `rememberMe` is false/omitted. Verified by reading `expiresAt` from the `session` row after each call.
- [ ] **R9 (REQ-013)**: Sign-in with a non-existent email AND sign-in with a wrong password for a real email both return the **same** generic error shape and the **same** HTTP status (401). No timing-side-channel test (out of scope), but the payloads must be identical.
- [ ] **R10 (REQ-014)**: After ≤10 failed sign-in attempts from the same IP, further attempts return 429 — using better-auth `rateLimit` defaults if they suffice, otherwise the `customRules` added in task #10. Verified by hammering the endpoint in an integration test.
- [ ] **R11 (REQ-015)**: `POST /api/auth/sign-out` deletes the current `session` row and clears the cookie. `GET /api/auth/get-session` immediately after returns `null` / 401.
- [ ] **R12 (REQ-016)**: The logged-out cookie, even if replayed by a client that cached it, no longer authenticates — the DB row is gone.
- [ ] **R13 (REQ-017, v3.docx §2.2.4)**: `GET /api/v1/sessions` returns `[{ id, userAgent, ipAddress, createdAt, expiresAt, current: boolean }]` for the logged-in user's non-expired sessions.
- [ ] **R14 (REQ-018, v3.docx §2.2.4)**: `DELETE /api/v1/sessions/:id` revokes a single session the caller owns. Revoking someone else's session returns 403. Revoking the caller's current session is allowed and behaves like logout.
- [ ] **R15 (REQ-019)**: `POST /api/auth/forget-password` with `{ email }` returns 200 regardless of whether the email exists (no enumeration). The endpoint currently **logs the reset token to stdout instead of sending email** — marked with a `TODO(S3)` and captured in §7.
- [ ] **R16 (transverse)**: Session cookie attributes are `HttpOnly; SameSite=Lax; Path=/; Secure` (the `Secure` flag depends on `NODE_ENV=production`, per better-auth defaults). Verified by asserting `Set-Cookie` headers in an integration test.
- [ ] **R17 (transverse)**: `SESSION_SECRET` is validated at boot by `src/env.ts` and must be ≥16 chars (we'll require ≥32 in prod per v3.docx §2.2). App fails to start otherwise.

## 5. Design notes

### Data model

Schema is already in `packages/shared/src/schema.ts`; the only S1 auth migration is the `user.username` NOT NULL flip in task #2.

- `user` — id, name, email (unique), emailVerified, image, **username** (unique, NOT NULL, immutable), createdAt, updatedAt, deletedAt.
- `session` — id, userId, token (unique), expiresAt, ipAddress, userAgent, createdAt, updatedAt.
- `account` — id, userId, accountId, providerId, password (hash), etc. better-auth stores the password hash here, not on `user`.
- `verification` — id, identifier, value, expiresAt. Used by better-auth for reset tokens.

Column names match better-auth defaults, so `drizzleAdapter(db, { provider: "pg" })` maps 1:1 without a custom field map.

**Schema tweak (decided)**: `user.username` flips to `NOT NULL` in the S1 migration; `user.additionalFields.username = { type: "string", required: true, input: true }` in `auth.ts` ensures better-auth writes it in the same insert as the user row. Verified against better-auth 1.3.8 docs via Context7 on 2026-04-18. No pre-insert hook needed.

### API surface

better-auth mounts under `/api/auth/*` (bridged into Fastify via `auth.handler`). The endpoints S1 uses:

| Route | Purpose | REQ |
| --- | --- | --- |
| `POST /api/auth/sign-up/email` | Register | REQ-001–009 |
| `POST /api/auth/sign-in/email` | Login (body takes `rememberMe`) | REQ-010–014 |
| `POST /api/auth/sign-out` | Logout current session | REQ-015, REQ-016 |
| `GET /api/auth/get-session` | Who am I? (used everywhere downstream) | session plumbing |
| `POST /api/auth/forget-password` | Request reset (STUB, logs token) | REQ-019 |
| `POST /api/auth/reset-password` | Consume reset token (STUB usable from logs) | REQ-019 |

Custom routes we own — thin wrappers around better-auth's native session APIs, only because v3.docx §2.2.4 wants a `current: boolean` flag on the listing:

| Route | Purpose | REQ |
| --- | --- | --- |
| `GET /api/v1/sessions` | List caller's active sessions with `current` flag | REQ-017 |
| `DELETE /api/v1/sessions/:id` | Revoke a specific session | REQ-018 |

Implementation: `GET` calls `auth.api.listSessions({ headers })` + `auth.api.getSession({ headers })` and tags the matching row with `current: true`. `DELETE` calls `auth.api.revokeSession({ headers, body: { token } })`. Ownership is enforced by better-auth (scoped to caller's session) — no custom guard.

### UI routes (Next.js, thin wrappers)

- `/register` — form wired to `authClient.signUp.email({...})`
- `/login` — form wired to `authClient.signIn.email({..., rememberMe})`
- `/account/sessions` — table of active sessions, revoke button per row, calls `DELETE /api/v1/sessions/:id`
- `/forgot-password` — form that POSTs to `/api/auth/forget-password`; always shows "if that email exists, a reset link was sent"

### Validation

Exists already in `packages/shared/src/dto.ts` — **reuse, don't re-invent**:

- `registerSchema` — `{ email: z.email(), username: usernameSchema, password: z.string().min(8).max(256), name: z.string().min(1).max(64) }`
- `loginSchema` — `{ email: z.email(), password: z.string().min(1), rememberMe: z.boolean().optional() }`
- `usernameSchema` — `3–32` chars, `^[A-Za-z0-9_]+$`

The Fastify bridge validates the body with these schemas **before** delegating to `auth.handler`, so zod issues surface cleanly instead of whatever better-auth decides to emit.

### Security posture

- **Password hashing**: better-auth's built-in (scrypt-based, no extra deps). We explicitly do NOT add argon2 or bcrypt. ADR-0001 already supersedes the v4 markdown that mentioned bcrypt cost-12.
- **Rate limiting**: better-auth `rateLimit` (enabled by default, in-memory storage). Task #10 verifies the default `window: 10s, max: 100` triggers a 429 on `/sign-in/email` inside the REQ-014 "10 failed attempts" budget; if not, we pin explicit `customRules` on sign-in / sign-up / forget-password. S3 may move the storage to Redis — noted in §7.
- **CSRF**: better-auth uses same-site cookies + origin check against `trustedOrigins: [env.WEB_ORIGIN]`. S3 will layer the double-submit token per REQ-146 — out of scope for S1.
- **Cookies**: `HttpOnly`, `SameSite=Lax`, `Secure` in prod, `Path=/`. Set by better-auth; we assert in tests (R16).
- **CORS**: Fastify registers `@fastify/cors` with `origin: env.WEB_ORIGIN, credentials: true` — already configured, just needs the auth routes mounted under the same server.
- **Email verification**: DISABLED for hackathon (`requireEmailVerification: false` in `apps/backend/src/auth.ts`). Called out here so a reviewer running down v3.docx §2.1 doesn't flag it as a bug. The `user.emailVerified` column stays in the schema (better-auth expects it) but is always `false`.
- **Secret strength**: `SESSION_SECRET` validated ≥16 chars at boot (R17); prod-deploy checklist requires ≥32.

## 6. Tasks (each <2h)

0. [ ] **Test rig** — add `supertest` + `@types/supertest` to `apps/backend/package.json`, scaffold `apps/backend/vitest.config.ts`, land one green `GET /health` integration test to prove the rig works.
1. [ ] Wire `auth.handler` into Fastify under `/api/auth/*` and add the `@fastify/cors` + cookie-parser plumbing. Smoke test with `curl` that `GET /api/auth/get-session` returns `null`. **Same PR deletes `docs/specs/auth.md`** (stale pre-pivot spec) so there's one source of truth before `pnpm trace` runs.
2. [ ] **Username enforcement + zod boundary guards** (split into 2a + 2b for reviewable commits):
    - **(2a) Schema + auth config**: flip `user.username` to `notNull()` in `packages/shared/src/schema.ts`, add `user.additionalFields.username = { type: "string", required: true, input: true }` to `auth.ts`, regenerate migration via `pnpm db:generate`, apply locally. Integration test: register with a missing `username` is rejected by better-auth before any DB write.
    - **(2b) Zod body guards + unit tests**: add `preHandler` on the `/api/auth/sign-up/email` and `/api/auth/sign-in/email` routes that validates the body against `registerSchema` / `loginSchema` BEFORE delegating to the better-auth bridge. Vitest unit tests for each failure mode (R5, R6 — malformed password, malformed username).
3. [ ] Integration test (Vitest + Supertest + test Postgres) for register happy path (R1, R2), duplicate email (R3), duplicate username (R4).
4. [ ] Integration test for login happy path + rememberMe (R7, R8), wrong-creds generic error (R9), rate limit (R10). **Before writing R9**, verify that better-auth returns the same error shape for `USER_NOT_FOUND` and `INVALID_PASSWORD`; if not, add a Fastify response rewriter that collapses both to one payload.
5. [ ] Integration test for logout (R11, R12) and cookie attributes (R16).
6. [ ] Implement `GET /api/v1/sessions` and `DELETE /api/v1/sessions/:id` as thin wrappers over `auth.api.listSessions` / `auth.api.revokeSession` (R13, R14) + integration tests.
7. [ ] Stub `forget-password` flow: supply `emailAndPassword.sendResetPassword` in `auth.ts` that logs `{ email, token }` via pino with a `TODO(S3)` marker — and redacts the token to its first 6 chars when `NODE_ENV === "production"` (R15). Integration test that any email returns 200.
8. [ ] Playwright e2e: register → see `/rooms` → refresh → still logged in → open `/account/sessions` → see one row → revoke → redirected to `/login`. Test names tagged with REQ-001, REQ-010, REQ-011, REQ-017, REQ-018.
9. [ ] **Pin session lifetimes** in `auth.ts`: `session.expiresIn = 60*60*24*7` (7d non-remember), `session.updateAge = 60*60*24`, `session.cookieCache = { enabled: true, maxAge: 60*5 }`. R8 then asserts `expiresAt - now > 29d` for remember=true and `<8d` for remember=false — deterministic, no floating defaults.
10. [ ] **Verify rate-limit defaults for REQ-014**: hammer `POST /api/auth/sign-in/email` and confirm a 429 within ≤10 attempts. If default `window: 10s, max: 100` lets more through, add `rateLimit.customRules: { "/sign-in/email": { window: 60, max: 5 }, "/sign-up/email": { window: 60, max: 3 }, "/forget-password": { window: 300, max: 3 } }` to `auth.ts`.

## 7. Out of scope / follow-ups

- **SMTP for password reset (REQ-019 completion)** — S3 hardening. Today the reset token is logged (redacted in prod, see task #7); a user can copy it from server logs in dev. Tracked as `TODO(S3): wire nodemailer/SES`.
- **Distributed rate-limit storage** — S3 will move better-auth's rate limiter to Redis so it survives backend restarts and scales across replicas.
- **CSRF double-submit token (REQ-146)** — S3.
- **Password change while logged in + "revoke all other sessions on password change"** — the endpoint exists in better-auth (`auth.api.changePassword`) but we're not surfacing UI for S1. S2 or S3.
- **Account deletion / soft-delete cascade** — out of hackathon scope.
- **Username change (REQ-127)** — explicitly deferred in `docs/BRIEF.md`.
- **10-fail lockout w/ captcha** — v4 markdown mentions this flavour of REQ-014, but better-auth's IP rate limit covers the observable behaviour. If a judge flags it, S3 adds a per-account counter.
- **ADR stubs (0001 stack-pivot, 0002 no-XMPP, 0003 watermark-protocol)** — cited by BRIEF.md and this spec but the files don't exist yet. Land 10-line stubs in `docs/adr/` before `/ship`.
- **BRIEF.md correction** — [docs/BRIEF.md:21](../BRIEF.md#L21) still says "bcrypt cost-12"; actual plan is better-auth's built-in scrypt. Fix in the same PR that lands this spec approval.

## 8. Open questions

- [ ] Do we want `/account/sessions` to be its own page or a dialog inside `/account`? (UI decision — ui-designer subagent calls it; not blocking spec approval.)
- [ ] Should `/api/v1/sessions` include or hide the current session's token hash? (Assumption: hide token, expose `current: true` on the matching row. Reviewer: confirm during code review.)

## 9. Acceptance test outline (REQ → test mapping)

`pnpm trace` greps `tests/` for each REQ-ID. This is the map it will check.

| REQ-ID | How exercised | Layer |
| --- | --- | --- |
| REQ-001 | register happy path inserts `user` row | integration (Vitest + Supertest) |
| REQ-002 | registerSchema rejects missing/invalid email | unit |
| REQ-003 | usernameSchema accepts valid + rejects invalid | unit |
| REQ-004 | register stores display name in `user.name` | integration |
| REQ-005 | register response sets session cookie; `get-session` returns user | integration |
| REQ-006 | duplicate email → 4xx, no duplicate row | integration |
| REQ-007 | duplicate username → 4xx | integration |
| REQ-008 | password <8 → 400 with zod issue | unit + integration |
| REQ-009 | username outside `[A-Za-z0-9_]{3,32}` → 400 | unit + integration |
| REQ-010 | login happy path returns cookie | integration |
| REQ-011 | cookie authenticates `get-session` | integration |
| REQ-012 | rememberMe=true → `session.expiresAt` > short lifetime | integration |
| REQ-013 | wrong email vs wrong password: identical 401 payload | integration |
| REQ-014 | N+1 sign-ins from same IP → 429 | integration |
| REQ-015 | sign-out deletes `session` row | integration |
| REQ-016 | post-logout cookie replay → 401 | integration |
| REQ-017 | `GET /api/v1/sessions` lists caller's sessions; `forget-password` endpoint returns 200 for any email | integration + e2e |
| REQ-018 | `DELETE /api/v1/sessions/:id` removes row; forbidden for other users | integration |
| REQ-019 | `forget-password` stub returns 200 + logs token | integration |

## 10. Decision log

Running record of implementation decisions made while executing this spec. Each entry: date, decision, alternatives considered, rationale, and the commit or file that embodies it. Durable ADRs live in `docs/adr/`; this log captures the smaller per-task calls that aren't ADR-worthy but a reviewer might still want to trace.

- **2026-04-18 (task #0) — supertest over `app.inject()`** (commit `9169cb4`). Fastify exposes `app.inject()` for synthetic requests, which is faster and dependency-free. Chose supertest instead because (a) the review in §3.6 recommended it, (b) it's framework-neutral so tests survive if we ever move off Fastify, (c) it behaves like a real HTTP client so cookie/header semantics match production. Cost: one extra devDep (`supertest` + `@types/supertest`, ~50 KB).
- **2026-04-18 (task #0) — `buildApp()` factory split from `server.ts`** (commit `9169cb4`). The original `server.ts` ran `Fastify() → register → listen()` inside one `main()`. Tests need a bootable app without binding a port. Factory returns the unlistened instance; `server.ts` imports it and layers `Socket.IO` + `listen()` on top. Alternatives considered: (a) export the full `main()` and teach tests to skip `listen()` — brittle; (b) use dependency injection — overkill for one entry point. Factory wins on simplicity.
- **2026-04-18 (task #0) — `tests/setup.ts` primes `process.env` before `src/env.ts`** (commit `9169cb4`). `env.ts` calls `process.exit(1)` on bad env at module-import time, which kills the whole test runner. Options considered: (a) `.env.test` + dotenv — adds a dep and another load path; (b) vitest's `env` option — only works for strings, not conditional behaviour; (c) a dedicated setup file wired via `setupFiles` — vitest loads it before any test module imports the SUT, so `env.ts` sees a valid `process.env`. Chose (c). Gotcha: `LOG_LEVEL` must be one of pino's enum values; `"silent"` fails the zod check, `"warn"` works. Saved to `memory: feedback` so a reviewer running the rig locally doesn't repeat the miss.
- **2026-04-18 (task #1) — Bridge better-auth's fetch handler into Fastify via a catch-all route** (commit `5753002`). See [ADR-0004](../adr/0004-auth-handler-bridge.md) for the full rationale; summary: `fastify-better-auth` plugin lags the core release cadence, a separate HTTP server means split-brain CORS, and a ~25-line catch-all route survives upgrades without touching third-party code.
- **2026-04-18 (spec approval) — BRIEF.md pre-pivot text corrected in same PR as spec + ADRs** (commit TBD, the one landing this log). BRIEF.md still referenced bcrypt cost-12 / Supabase Realtime / 4096-byte message body from the v4 markdown. Corrected to scrypt / Socket.IO / 3072-byte (v3 §2.5.2) to match the committed stack. v4 markdown itself is left untouched — it's AI-prep per `memory: feedback-task-mds-are-prep`, not authoritative.
- **2026-04-18 (before task #2) — Split task #2 into 2a + 2b** (this commit). Original task #2 bundled schema-migration, better-auth `additionalFields` config, zod `preHandler` guards, and unit tests into one commit. That hides four independently-reviewable changes behind one diff. Split into 2a (schema + auth config + one DB-write-gate integration test) and 2b (zod boundary guards + unit tests). Reasoning: if 2b's guards have a bug, we don't want to bisect through a schema migration to find it.
- **2026-04-18 (task #2a) — Use a SQL-literal default instead of a `0n` BigInt for bigint columns** (commit TBD). drizzle-kit 0.31.10 throws `TypeError: Do not know how to serialize a BigInt` when snapshotting a column whose default is the JS BigInt literal `0n`. Both `message_seq.seq` and `room_member.last_read_seq` hit this. Fix: `import { sql } from "drizzle-orm"` and declare the default as ``.default(sql`0`)``. Alternatives considered: (a) downgrade drizzle-kit (risks unknown migration-diff bugs), (b) drop the default and initialize in app code (leaks an invariant out of the schema). The SQL literal is the smallest, most honest fix. Applies to any future bigint column with a numeric default.
