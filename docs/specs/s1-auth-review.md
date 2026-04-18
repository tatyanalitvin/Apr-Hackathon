# Review: S1 Auth Spec (`docs/specs/s1-auth.md`)

**Reviewer**: Claude Code (Opus 4.7)
**Date**: 2026-04-18
**Subject of review**: [docs/specs/s1-auth.md](./s1-auth.md)
**Outcome requested**: spec sign-off for `/tdd`, with the minimum set of concrete edits.

## TL;DR

**Approve with 6 small edits listed in §4.** No architectural rewrites needed. The spec is unusually good for a 24 h hackathon — REQ mapping is tight, non-goals are honest, open questions are all decidable in under 10 min each. The edits below tighten one open question to a decision, cut task #6 in half via better-auth's native session APIs, and patch a few infrastructure gaps that aren't yet in the spec.

---

## 1. Ground truth — what's actually on disk

Confirmed by direct file reads + an Explore pass:

| Claim in spec | Reality |
| --- | --- |
| Drizzle schema has `user`/`session`/`account`/`verification` with better-auth defaults | ✅ [packages/shared/src/schema.ts](../../packages/shared/src/schema.ts) — 1:1 with drizzleAdapter |
| `user.username` is unique but nullable | ✅ [schema.ts:52](../../packages/shared/src/schema.ts#L52) — `text("username").unique()`, no `notNull()` |
| `registerSchema`/`loginSchema`/`usernameSchema` already exist | ✅ [packages/shared/src/dto.ts:7-33](../../packages/shared/src/dto.ts#L7-L33) |
| `auth.ts` wired with `drizzleAdapter` + `emailAndPassword` | ✅ [apps/backend/src/auth.ts](../../apps/backend/src/auth.ts) |
| Fastify has `/api/auth/*` bridge mounted | ❌ [apps/backend/src/server.ts](../../apps/backend/src/server.ts) registers CORS + `/health` only. Task #1 must add it. |
| `/api/v1/sessions` custom routes exist | ❌ missing — task #6 |
| Frontend `/register`, `/login`, `/account/sessions`, `/forgot-password` exist | ❌ only `layout.tsx` + `page.tsx` in [apps/web/src/app/](../../apps/web/src/app/) |
| `docs/specs/auth.md` is the pre-pivot stub to delete | ✅ confirmed — Prisma + argon2 + homemade sessions |
| `docs/adr/0001-stack-pivot.md` referenced by spec and BRIEF | ❌ `docs/adr/` does not exist on disk — spec cites three ADRs (0001, 0002, 0003) that were never written |
| Supertest installed in `apps/backend` | ❌ not a dep — tasks #3–#7 need it added |
| Vitest config in backend | ❌ missing — backend has no `vitest.config.ts` yet |

---

## 2. The four highlighted items — direct answers

### 2.1 §5 / §8 — `user.username` nullable vs. NOT NULL

**Verdict: resolve in favour of NOT NULL via `user.additionalFields`. No pre-insert hook needed.**

Context7 confirmed against `/llmstxt/better-auth_llms_txt`:

> **POST `/sign-up-email`** — "This endpoint supports and returns custom fields defined in the user schema. Custom fields added to the user table will be included in the response."
>
> Config pattern:
> ```ts
> user: { additionalFields: { role: { type: "string", required: true, input: true } } }
> ```

Setting `user.additionalFields.username = { type: "string", required: true, input: true }` (a) forces clients to pass `username` in the sign-up body, (b) writes it to the `user` row in the same insert better-auth performs, and (c) surfaces a clean validation error if omitted. That atomic insert is exactly what we want — the option-(b) pre-insert hook becomes dead weight.

**Apply:**
1. Drizzle migration flips `user.username` to `notNull()`. Single ALTER, no backfill (no rows yet).
2. `auth.ts` adds `user: { additionalFields: { username: { type: "string", required: true, input: true } } }`.
3. Replace the open question in §8 with the decision and verification timestamp.

**Sibling note (not blocking):** better-auth ships a `username` plugin (`better-auth/plugins/username`) that adds `signIn.username` and validates the username column natively. We don't need sign-in-by-username for REQ-010 (email only), and adopting the plugin means migrating our `registerSchema` shape. **Stay with `additionalFields` + our zod schemas** — strictly less work and matches the existing DTO pattern.

### 2.2 §7 — Password-reset email stubbed to stdout

**Verdict: stub is fine for the submission gate.** Three reasons:

1. `docker compose up` is the ONLY organizer-mandated bar (per CLAUDE.md and BRIEF.md). A judge running compose does not need working SMTP to observe register → login → room.
2. v3.docx §2.2 asks that the *endpoint exists* and *doesn't enumerate*. R15 covers both — token lands in logs, response is identical for every email.
3. Wiring SMTP burns ~1 h on a surface zero judges exercise.

**Two safety nails to add to the spec, currently absent:**
- `sendResetPassword` config MUST be explicitly supplied (e.g. `app.log.info({ email, token, todo: "S3: email transport" })`). If left undefined, better-auth throws at runtime on `POST /api/auth/forget-password`.
- The log line MUST redact the token in production (`token.slice(0, 6) + "…"` when `NODE_ENV === "production"`). This pre-empts the "you logged a live secret in the demo" objection.

### 2.3 Task #9 — delete `docs/specs/auth.md`

**Verdict: correct call, but move it to the FIRST implementation PR, not the last.** Two competing specs in the tree confuse the `code-reviewer` subagent and `pnpm trace`. Bundle the delete with the auth-handler bridge (current task #1) so `feat/s1-auth`'s opening commit removes the stale source of truth.

### 2.4 §9 — REQ → test mapping for `pnpm trace`

**Verdict: the mapping is complete, but the test-name discipline needs a concrete example.** Spec says "Test `describe`/`test` names MUST embed these IDs verbatim" once. Add a 4-line example block so every contributor (human or AI) copies the same shape:

```ts
describe("REQ-006 duplicate email rejected", () => {
  test("REQ-006 returns 4xx and inserts no row", async () => { ... });
});
```

**One REQ slot to challenge:** `REQ-013` (identical 401 payload for wrong-email vs. wrong-password). Better-auth's default error shapes for `USER_NOT_FOUND` and `INVALID_PASSWORD` differ unless you collapse them. **Verify before task #4** that better-auth returns one shape; if not, the Fastify guard rewrites the response body. Add a TODO to task #4.

---

## 3. Additional strategic findings (not in your highlights, but worth eyeballing)

### 3.1 Native session management — cuts task #6 in half

Better-auth ships the session APIs natively (Context7-verified):

```ts
await authClient.listSessions()                // returns all active for caller
await authClient.revokeSession({ token })      // revokes one
await authClient.revokeOtherSessions()         // bulk revoke
```

The spec proposes **custom** `GET /api/v1/sessions` and `DELETE /api/v1/sessions/:id`. The only delta we need beyond better-auth's built-ins is the `current: boolean` flag from v3.docx §2.2.4.

Make the custom routes ~8-line wrappers:

```ts
fastify.get("/api/v1/sessions", async (req) => {
  const { session } = await auth.api.getSession({ headers: req.headers });
  const all = await auth.api.listSessions({ headers: req.headers });
  return all.map(s => ({
    id: s.id, userAgent: s.userAgent, ipAddress: s.ipAddress,
    createdAt: s.createdAt, expiresAt: s.expiresAt,
    current: s.id === session?.id,
  }));
});
```

Ownership is automatic — better-auth scopes to the caller's session. **Drop the "enforce ownership" branch from §5** (redundant). `DELETE` becomes a 3-line wrapper around `auth.api.revokeSession`. Net: task #6 shrinks ~1.5 h → ~30 min, and R14's "forbidden for other users" branch becomes verification of a built-in rather than our own guard.

### 3.2 Rate limit — confirm defaults before relying on R10

Context7 confirmed global defaults: **`window: 10s, max: 100 requests`**. That's a per-path rule. Better-auth 1.3.x ships tighter `customRules` for `/sign-in/email` out of the box, but the docs don't pin the exact numbers.

**Action:** Before writing R10, hammer `POST /api/auth/sign-in/email` with a script and confirm a 429 within a sane attempt count. Brief says "10-fail lockout"; if defaults allow 100/10s on sign-in, that's too loose for REQ-014. Add explicit rules:

```ts
rateLimit: {
  customRules: {
    "/sign-in/email":   { window: 60,  max: 5 },
    "/sign-up/email":   { window: 60,  max: 3 },
    "/forget-password": { window: 300, max: 3 },
  },
}
```

Promote to an open question in §8 to decide on day-of, not blind.

### 3.3 `rememberMe` lifetimes — pin them, don't trust "defaults"

§4 R8 says "short lifetime" vs. "long lifetime (30 days default)". Better-auth's actual defaults are `session.expiresIn: 7 days`; `rememberMe: true` extends via cookie `maxAge` math. Don't test against a floating default.

Set explicit values in `auth.ts`:

```ts
session: {
  expiresIn: 60 * 60 * 24 * 7,      // 7d non-remember
  updateAge: 60 * 60 * 24,
  cookieCache: { enabled: true, maxAge: 60 * 5 },
},
```

R8 then asserts `expiresAt - now > 29d` for remember=true and `<8d` for remember=false. Deterministic.

### 3.4 BRIEF.md says bcrypt cost-12 — stale, fix before reviewers see it

[docs/BRIEF.md:21](../BRIEF.md#L21):

> bcrypt cost-12 hash (we deviate from argon2id — ADR-0001 captures why: GoTrue default).

Pre-pivot drift. Actual plan is better-auth's built-in scrypt. A reviewer spotting `bcrypt` in BRIEF and `scrypt` in s1-auth.md will open a ticket. Land a one-line correction in the same PR that lands s1-auth.md, OR add it to §7 follow-ups.

### 3.5 ADR files don't exist — decide now

Spec cites ADR-0001 (stack pivot), ADR-0002 (no XMPP), ADR-0003 (watermark). None on disk. Options:

- **(a)** Write all three as 10-line stubs before `/tdd`. Low effort, big credibility win with judges.
- **(b)** Remove citations from s1-auth.md and BRIEF.md. Loses narrative.
- **(c)** Leave aspirational and hope nobody greps. Bad.

**Recommendation: (a).** ~20 min of work, not spec-blocking. Add to §7 follow-ups so it doesn't get lost.

### 3.6 Supertest missing — infrastructure gap for tasks #3–#7

`apps/backend/package.json` has no `supertest` or `@types/supertest`. Every integration task in the spec depends on it. **Add a task #0**: "Install supertest + @types/supertest + scaffold `vitest.config.ts` in apps/backend; one green `GET /health` integration test proves the rig works." ~20 min and it de-risks the whole test wave.

---

## 4. Concrete edits to apply to `docs/specs/s1-auth.md` before `/tdd`

All small; none change the spirit of the spec.

1. **§5 (Data model)** — replace the "Potential schema tweak (flagged, not blocking)" paragraph with: "`user.username` will flip to `NOT NULL` in the S1 migration; `user.additionalFields.username = { required: true }` in `auth.ts` ensures atomic insert. Verified against better-auth 1.3.8 docs on 2026-04-18."
2. **§8 (Open questions)** — remove the `additionalFields` question (resolved); remove the short-session-lifetime question in favour of pinned values from §3.3. Keep the UI page-vs-dialog question and the `current: true` exposure question.
3. **§6 (Tasks)** — add **task #0**: install supertest, @types/supertest, scaffold `vitest.config.ts` in apps/backend, 1 green `/health` integration test. Move current task #9 (`delete docs/specs/auth.md`) into the same PR as task #1.
4. **§4 / §5 (test discipline)** — add a 4-line example of a REQ-tagged `describe`/`test` block (see §2.4 of this review).
5. **§5 (Custom routes)** — rewrite the `/api/v1/sessions` paragraph around `auth.api.listSessions` and `auth.api.revokeSession`; drop ownership-guard language (redundant).
6. **§7 (Follow-ups)** — add three one-liners: "ADR-0001/0002/0003 files", "BRIEF.md bcrypt→scrypt correction", "SMTP for reset email".

Optional (bonus robustness, not blocking):
- Add a task "pin `session.expiresIn` and rememberMe lifetimes in `auth.ts`" to §6.
- Add a task "confirm `/sign-in/email` default rate-limit gives a 429 before 10 attempts; if not, add a `customRules` entry".

---

## 5. Files touched by S1 (for the implementer)

Critical paths, in execution order:

1. [apps/backend/package.json](../../apps/backend/package.json) — add `supertest`, `@types/supertest`.
2. `apps/backend/vitest.config.ts` — new.
3. [apps/backend/src/auth.ts](../../apps/backend/src/auth.ts) — add `user.additionalFields`, pin session lifetimes, `sendResetPassword` stub, `rateLimit.customRules` if §3.2 check fails.
4. [packages/shared/src/schema.ts:52](../../packages/shared/src/schema.ts#L52) — `username` → `notNull()`.
5. [infra/migrations/](../../infra/migrations/) — new SQL from `pnpm db:generate` after the schema tweak.
6. [apps/backend/src/server.ts](../../apps/backend/src/server.ts) — mount `auth.handler` at `/api/auth/*`; add `GET /api/v1/sessions`, `DELETE /api/v1/sessions/:id`.
7. `apps/web/src/app/{register,login,account/sessions,forgot-password}/page.tsx` — new; wire with `authClient`.
8. `tests/e2e/auth.spec.ts` — new; Playwright flow from §6 task #8.
9. [docs/specs/auth.md](./auth.md) — delete.
10. [docs/BRIEF.md:21](../BRIEF.md#L21) — bcrypt → scrypt correction.

---

## 6. Verification (end-to-end)

After the spec edits land and `/tdd` runs through tasks #0 → #8:

1. `pnpm install` (fresh clone) — must succeed.
2. `pnpm db:migrate` against compose Postgres — no errors; `\d user` shows `username | not null`.
3. `pnpm --filter backend test:run` — all integration tests green, including R1–R16.
4. `pnpm --filter web dev` + register/login/revoke in the browser — cookies set, `/account/sessions` lists current with `current: true`, revoke returns to `/login`.
5. `pnpm test:e2e` — Playwright flow passes on a fresh DB.
6. `pnpm trace` — zero missing REQ-IDs from REQ-001 through REQ-019.
7. `docker compose up` on a clean machine — register → login → see session loop works end-to-end. **This is the submission gate.**

If any of 1–7 fails, stop and ask; do not loosen tests.
