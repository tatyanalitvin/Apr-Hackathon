---
name: REQ-ID Catalog v4 Retrofit
description: Remediation of the drift between v4.md canonical REQ catalog and s1-auth / s1-chat / S2 spec REQ-ID usage
type: design
status: approved-design
date: 2026-04-18
---

# REQ-ID Catalog v4 Retrofit — Design

> This is the architecture reference. The executable task decomposition lives in the companion implementation plan produced by the `writing-plans` skill and should be read alongside this doc.

## 1. Why

Two REQ-ID schemes are live in the codebase:

- **v4.md catalog** (`task/Chat_Server_Requirements_v4.md`) — the external prep catalog with rigorous per-REQ acceptance criteria. ~195 REQs defined.
- **s1-* / s2-* internal scheme** — REQ-IDs embedded in feature specs and test `describe` blocks. Diverged from v4.md during initial auth slice authorship and has propagated unevenly.

`pnpm trace` ([scripts/trace-req-ids.mjs](../../scripts/trace-req-ids.mjs), commit `604aed5`) has NO allow-list mechanism: it extracts REQ-IDs from spec §4 checkbox lines, scans tests for matches, and fails on any `§4` REQ with no test reference (or, with `TRACE_STRICT=1`, on any zombie REQ in tests). This makes the drift actively costly — every false-positive claim in §4 breaks the gate.

Audit result (verified against [v4 catalog](../../task/Chat_Server_Requirements_v4.md) §§3-4, session 2026-04-18):

| Artifact | Alignment | Drift surface |
| --- | --- | --- |
| [s1-web.md](../specs/s1-web.md) + web tests | ✅ fully aligned | — |
| [s1-chat.md](../specs/s1-chat.md) + chat tests | ✅ mostly aligned | R2 misuses REQ-030+REQ-037 for seq behaviour (v4 says those are "body size" + "offline delivery"); REQ-049 "seed" has no v4 home (v4 REQ-049 = "Stage 1 exit criteria") |
| [s2-friendship.md](../specs/s2-friendship.md) | ✅ aligned | — |
| [s2-dms.md](../specs/s2-dms.md) | ✅ aligned | — |
| [s2-attachments.md](../specs/s2-attachments.md) | ❌ fully drifted REQ-076..085 | every ID shifted 1-4 slots vs v4 |
| [s2-afk-presence.md](../specs/s2-afk-presence.md) | ⚠️ middle drifted | REQ-099 + REQ-105 OK; REQ-100..104 semantics all shifted |
| [s1-auth.md](../specs/s1-auth.md) + 15+ auth tests | ❌ fully drifted | REQ-003..REQ-009 misused across spec §4, §9, test describes; ghost REQ-022 in [auth.ts:105](../../apps/backend/src/auth.ts#L105) |

S2 implementation has **not** started (only `feat/s1-auth` branch has shipped code; S2 specs are spec-only). Fixing now is a rename. Fixing later means also renaming the S2 test files that don't yet exist.

## 2. Non-goals

1. **No semantic retrofit of v4 rules — with one exception.** v4's stricter semantics (REQ-006 12-char password + blocklist, REQ-007 `passwordConfirm` field, REQ-008 argon2id, REQ-003/005 case-insensitive uniqueness) stay on FOLLOWUPS.md as deliberate hackathon deferrals documented in ADR-0006. **Exception: REQ-009 register rate limit.** @fastify/rate-limit is already wired in [auth.ts:96-103](../../apps/backend/src/auth.ts#L96-L103) with a sign-in custom rule. Adding a sign-up rule is one line + one test. Pulling it into this retrofit, not deferring.
2. **No code behaviour changes in the rename work itself.** Only REQ-ID labels on `describe` blocks, spec bullets, and code comments. The single behavioural addition (REQ-009 register rate limit) is scoped as a separate task with its own test and commit — kept out of the rename commits so reverts are surgical.
3. **No restructure of v4.md itself.** v4 is the canonical catalog; we conform to it.
4. **No retroactive git history rewrites.** Past commits keep their old REQ-IDs in messages.
5. **No Phase 2 staging.** S2 spec renames (s2-attachments, s2-afk-presence) are in this single-phase plan. Deferring them trades ~30min now for the same "which scheme is this?" tax on every future spec read.

## 3. Scope — single unified phase, rename-first, then REQ-009 implementation

### 3.1 Artifact inventory and target state

| # | Path | Current drift | Target state | Effort |
| --- | --- | --- | --- | --- |
| 1 | [s1-auth.md](../specs/s1-auth.md) | §3, §4, §9 all use drifted scheme | §4 checkboxes only for genuinely-covered v4 REQs (REQ-001 register endpoint, REQ-010 login, REQ-011-015 session/keepMeSignedIn/lockout/TTL, REQ-016 password change, REQ-017 password reset minimal, REQ-018 sessions list, REQ-019 session revoke, REQ-125 delete account); deviations (REQ-003, REQ-005, REQ-006, REQ-007, REQ-008) moved to §7 "Out of scope / follow-ups" as explicit deferrals with ADR-0006 reference | 45min |
| 2 | [register.test.ts](../../apps/backend/tests/register.test.ts) | L29 describe `REQ-001 REQ-004`; L78 `REQ-005 session cookie` (v4 REQ-005 = username uniqueness); L111 `REQ-006 duplicate email` (v4 REQ-006 = password policy); L139 `REQ-007 duplicate username` (v4 REQ-007 = passwordConfirm) | L29 `REQ-001 register happy path…` (REQ-004 is username format per v4, NOT asserted here — strip from describe); L78 describe → `REQ-001 register response sets session cookie authenticating get-session` (session cookie behaviour is part of v4 REQ-001 acceptance); L111 `REQ-003 duplicate email rejected…` (v4 REQ-003 = email uniqueness; current test is case-sensitive, a subset of v4's case-insensitive requirement — ADR-0006 entry); L139 `REQ-005 duplicate username rejected…` (v4 REQ-005 = username uniqueness; same subset caveat) | 20min |
| 3 | [schemas.test.ts](../../apps/backend/tests/schemas.test.ts) | L9 `REQ-008 password length` (v4 REQ-008 = argon2id); L35 `REQ-009 usernameSchema` (v4 REQ-009 = register rate limit); L57 `REQ-002 email format` ✓ OK; L69 `REQ-010 login schema` ✓ OK | L9 describe → strip REQ prefix, rename to `"registerSchema rejects short password (deviation from v4 REQ-006)"` with inline comment referencing ADR-0006 — behaviour is real but doesn't map to any v4 REQ under current policy; L35 `REQ-004 usernameSchema enforces [A-Za-z0-9_]{3,24}` (v4 REQ-004 = username format regex — our regex is `{3,32}`, v4's is `{3,24}`, one-line ADR-0006 deviation); L57 stays (v4 REQ-002 = email format ✓); L69 stays | 15min |
| 4 | [register-auto-enroll.test.ts](../../apps/backend/tests/register-auto-enroll.test.ts) | Entire file built around ghost REQ-022 | Strip REQ- prefix. Rename describe to `"auto-enroll new user into seeded 'general' room on signup (non-v4 convenience, see ADR-0006)"`. Keep filename. This is **permanent** live regression coverage for auth.ts:117-143 — per s2-rooms.md R1 `[x]` (commit ee0b136), auto-enroll ships indefinitely. Deletion framing from earlier draft was wrong | 10min |
| 5 | [sessions-list.test.ts](../../apps/backend/tests/sessions-list.test.ts) | Uses current scheme's REQ-017 (sessions list) | v4 REQ-018 = "Sessions list endpoint" → rename describes from REQ-017 to REQ-018 | 5min |
| 6 | [sessions-revoke.test.ts](../../apps/backend/tests/sessions-revoke.test.ts) | Uses REQ-018 for revoke | v4 REQ-019 = "Revoke a specific session" → rename REQ-018 → REQ-019 | 5min |
| 7 | [login.test.ts](../../apps/backend/tests/login.test.ts) | Spot-check needed; suspected drift on REQ-010/011/012 | v4: REQ-010 login endpoint, REQ-011 keep-me-signed-in, REQ-012 login failure lockout. Rename per actual assertion; any lockout-related describe goes to REQ-012 | 10min |
| 8 | [logout.test.ts](../../apps/backend/tests/logout.test.ts) | Spot-check; likely uses REQ-013 or REQ-014 | v4 REQ-013 = "Logout (current session)" → align | 5min |
| 9 | [rate-limit.test.ts](../../apps/backend/tests/rate-limit.test.ts) | L33 describe `REQ-014 sign-in rate limit (R10)`; L43 test `REQ-014 5 wrong-password attempts return 4xx; 6th returns 429` | Single describe, no split. **Outcome B (deviation, not subset match):** v4 REQ-012 is *email-scoped* lockout (10 fails/15min, code `auth_locked`); this test is *IP-scoped* rate limit (5 fails/60s, 429 via @fastify/rate-limit). Different semantics — botnet bypasses IP rate limit, which is exactly what REQ-012 prevents. Strip REQ- prefix: describe → `"sign-in IP rate limit (deviation from v4 REQ-012 per-email lockout, see ADR-0006)"`. Update file's top comment block (L1-18) which references REQ-014 four times + L1 "Task #4 R10 (REQ-014)" lineage. Add REQ-012 to ADR-0006 deviation list and FOLLOWUPS | 10min |
| 10 | [password-reset-request.test.ts](../../apps/backend/tests/password-reset-request.test.ts) | Uses pre-v4 scheme | v4 REQ-017 = "Password reset (S1 minimal)" → rename | 5min |
| 11 | [account-delete.test.ts](../../apps/backend/tests/account-delete.test.ts) | Uses pre-v4 scheme | v4 REQ-125 = "Delete account action" → rename | 5min |
| 12 | [s1-chat.md](../specs/s1-chat.md) | §4 R2 uses REQ-030+REQ-037 for seq ordering; §4 R6 mentions REQ-034 for broadcast; §7/§4 uses REQ-049 for seed | R2 → REQ-032 only (v4 REQ-032 = "Server-assigned ordering"); R6 → REQ-034 (v4 REQ-034 = "Persistence") + REQ-036 (v4 REQ-036 = "Delivery to online users"); REQ-049 seed references moved to §7 out-of-scope with "seed is infra not v4" note | 20min |
| 13 | [messages-*.test.ts](../../apps/backend/tests/) + [socket-*.test.ts](../../apps/backend/tests/) | Mirror s1-chat drift on REQ-030/REQ-037/REQ-049 | Align describes to REQ-032, REQ-034, REQ-036 per assertion. Any "seed" REQ-049 describes → strip prefix like schemas.test.ts L9 | 30min |
| 14 | [s2-attachments.md](../specs/s2-attachments.md) | REQ-076..085 fully drifted | Remap per v4 catalog: REQ-075 types ✓, REQ-076 SVG (NOT upload methods), REQ-077 size limits (NOT metadata), REQ-078 download-as-attachment, REQ-079 upload methods, REQ-080 progress/cancel, REQ-081 filename, REQ-082 optional comment, REQ-083 download authz, REQ-084 persistence-vs-room-delete, REQ-085 persistence-vs-user-loses-access. Spec-only file, no tests to update | 20min |
| 15 | [s2-afk-presence.md](../specs/s2-afk-presence.md) | REQ-099 ✓, REQ-100..104 drifted, REQ-105 ✓ | v4: REQ-100 activity signal from client, REQ-101 server-side computation, REQ-102 propagation SLO, REQ-103 presence visibility scope, REQ-104 cross-device semantics. Rewrite the §3 assignment table | 15min |
| 16 | [auth.ts:105-116](../../apps/backend/src/auth.ts#L105-L116) | Comment fabricates REQ-022 (v4 REQ-022 = "Room description") | Replace per unified diff in §4.3 below | 5min |
| 17 | [s2-rooms.md](../specs/s2-rooms.md) | §4 R1 REQ-022 auto-enroll (not in v4; v4 REQ-022 = "Room description"); §4 R2 REQ-022 self-join (v4: REQ-026 "Join public room"); §4 R3 REQ-023 catalog (v4: REQ-025 "Room catalog"); §4 R4 REQ-023 `/rooms/me` (no v4 REQ — data-model read, closest to v4 REQ-020 "Data model") | R1 → move from §4 checkbox to §7 "Out of scope / non-v4 deviations" with ADR-0006 link (auto-enroll is permanent non-v4 behaviour per commit ee0b136). Remove REQ-022 from R1's describe label; test stays. R2 → §4 checkbox stays, rename REQ-022 → REQ-026. R3 → §4 checkbox stays, rename REQ-023 → REQ-025. R4 → §4 checkbox stays, rename REQ-023 → outcome B strip-prefix: `"/rooms/me caller-membership listing (non-v4, covered by data-model REQ-020 in spirit)"`. Update §9 REQ→test mapping table accordingly. Update §5 design notes where they reference REQ-022/023 by number (cross-ref only, not semantics) | 15min |

**Rename-phase total: ~3h15min. REQ-009 implementation (see §3.2): +~20min.**

### 3.2 REQ-009 register rate limit — small behavioural add

**Why in-scope:** @fastify/rate-limit already wired; existing customRule at [auth.ts:102](../../apps/backend/src/auth.ts#L102) for sign-in. Adding sign-up rule is mechanical.

**Scope:**

- Add `"/sign-up/email": { window: 3600, max: 5 }` to `customRules` (v4: 5 per IP per hour). The `/24` subnet rule from v4 is deferred to FOLLOWUPS (requires custom keyGenerator + CIDR math — not 15 lines).
- New test file [register-rate-limit.test.ts](../../apps/backend/tests/register-rate-limit.test.ts) with one describe: `REQ-009 register rate limit — 6th attempt from same IP within hour returns 429`. Use existing rate-limit.test.ts pattern as template.
- Separate commit from the rename work so the behavioural change is a single reviewable unit.

### 3.3 ADR-0006 and FOLLOWUPS updates

**New ADR `docs/adr/0006-req-catalog-canonical.md`:**

```markdown
# ADR-0006 — REQ-ID catalog: v4.md is canonical

## Context
- v4.md = external prep catalog with rigorous per-REQ acceptance criteria
- s1-* specs initially used a drifted internal scheme
- `pnpm trace` (commit 604aed5) makes the drift actively costly — no allow-list
- Audit session 2026-04-18 identified drift in s1-auth, s1-chat, s2-attachments, s2-afk-presence (s1-web, s2-friendship, s2-dms were already aligned)

## Decision
v4.md is the single source of truth for REQ-IDs. All specs, tests, and code comments MUST reference v4 REQ semantics. Specs claim REQs via §4 checkboxes only for REQs genuinely covered by tests; deferrals live in §7.

## Accepted deviations (S1 scope, hackathon timebox)
| v4 REQ | v4 rule | Our implementation | Rationale | Revisit |
|---|---|---|---|---|
| REQ-003 | case-insensitive email uniqueness | case-sensitive via better-auth default | S3 hardening | S3 |
| REQ-005 | case-insensitive username uniqueness | case-sensitive | ditto | S3 |
| REQ-006 | 12-char min + top-10k blocklist | 8-char min, no blocklist | better-auth default. **Test fixtures use `password: "password1234"` across register.test.ts, login.test.ts, schemas.test.ts, seed.ts — this value IS on v4's top-10k blocklist. If REQ-006 is ever implemented, every fixture breaks.** | S3 |
| REQ-007 | passwordConfirm field | no confirmation field | UI test-after; single-password UX OK for demo | S3 |
| REQ-012 | per-email lockout (10 fails/15min, code `auth_locked`) | per-IP rate limit (5 fails/60s, 429) | IP rate limit is weaker — botnet bypass. Implementing per-email lockout requires a new counter store keyed by email (or repurposing Redis keys) + `auth_locked` error code wiring through better-auth's login handler. Not mechanical. | S3 |
| REQ-008 | argon2id (memoryCost=19456,timeCost=2) | scrypt via better-auth 1.6.5 default | ADR-0001 pivot rationale; changing here unwinds better-auth adoption | S3 or never |
| REQ-009 `/24` subnet rule | 20 registrations per /24 per hour | per-IP rule only (5/IP/hr) | custom keyGenerator + CIDR math, not mechanical. Per-IP is honoured. | S3 |
| "REQ-022 ghost" → now formal non-v4 deviation | v4 REQ-022 = "Room description" (unimplemented) | [auth.ts:117-143](../../apps/backend/src/auth.ts#L117-L143) auto-enrolls new users in 'general'; covered by [register-auto-enroll.test.ts](../../apps/backend/tests/register-auto-enroll.test.ts); claimed in s2-rooms.md §7 (non-v4 deviations) | **Permanent** non-v4 UX convenience (per commit ee0b136 shipping R1 `[x]`). Prevents the signup-to-first-message dead-end without forcing a manual `#general` join. v4 REQ-022 "Room description" proper is a separate, deferred item (see FOLLOWUPS #10). | never |

## Consequences
- FOLLOWUPS.md contains one actionable entry per deviation row
- `pnpm trace` is green because deviations live in §7, not §4 checkboxes
- Test describes for deviations strip the `REQ-` prefix (they test real behaviour that doesn't map to any v4 REQ)
- Any new REQ-ID introduced in future work MUST reference v4; inventing an ID is a bug
```

**FOLLOWUPS.md enumerated additions (final list, not expected):**

1. `REQ-003 case-insensitive email uniqueness` — test currently exercises case-sensitive path via [register.test.ts:111](../../apps/backend/tests/register.test.ts#L111); add a case-variation test when better-auth 1.6.5+ lowercasing is wired
2. `REQ-005 case-insensitive username uniqueness` — same pattern as REQ-003
3. `REQ-006 password policy (12-char + top-10k blocklist)` — includes note that all test fixtures + seed use "password1234" which is on the blocklist; any impl MUST rewrite fixtures in lockstep
4. `REQ-007 passwordConfirm field` — schema change in `packages/shared/src/dto.ts`; UI change in register form
5. `REQ-008 argon2id` — ADR-0001 says not happening without unwinding better-auth adoption
6. `REQ-009 /24 subnet rate limit` — custom keyGenerator in @fastify/rate-limit; CIDR math; deferred (per-IP rule IS implemented in this retrofit, §3.2)
7. `REQ-012 per-email lockout` — current rate-limit.test.ts exercises IP-scoped 429 only; per-email counter + `auth_locked` code are S3 work (see ADR-0006 row)
8. `auto-enroll is permanent, not a hotfix` — [auth.ts:117-143](../../apps/backend/src/auth.ts) + [register-auto-enroll.test.ts](../../apps/backend/tests/register-auto-enroll.test.ts) stay indefinitely per s2-rooms.md R1 `[x]` (commit ee0b136). No deletion when S2 rooms (v4 REQ-025/REQ-026) lands
9. `s1-chat REQ-049 seed` — seed script is demo infra, not a v4 REQ. Trace doesn't need to claim it. Keep seed.test.ts describe without REQ- prefix
10. `v4 REQ-022 "Room description"` — not implemented. `room.description` column exists in [schema.ts](../../packages/shared/src/schema.ts), but there is no UI or API enforcement of description format/length/visibility. Deferred until a future spec claims it in §4

## 4. Architecture — rename procedure (checklist)

### 4.1 Per-describe-block rename checklist

Apply this for every `describe("REQ-XXX foo")` touched:

- [ ] Read the assertion body
- [ ] Look up v4 REQ-YYY acceptance criteria
- [ ] Decide one of three outcomes:
  - [ ] **A — subset match:** assertion is a strict subset of v4 REQ-YYY's acceptance → rename `REQ-XXX` → `REQ-YYY`
  - [ ] **B — broader/incompatible:** assertion doesn't map to any v4 REQ cleanly → strip `REQ-` prefix; rename describe to plain-English `"what the test asserts (deviation from v4 REQ-YYY, see ADR-0006)"`
  - [ ] **C — dual match:** assertion genuinely covers two v4 REQs in one test body (e.g. a test that exercises both an endpoint's authorization AND its rate limit in a single flow). Dual-embed in describe: `"REQ-XXX REQ-YYY …"` — valid per trace regex `/REQ-\d{3,}/g` which matches each ID independently. No clean dual-match case exists in the current test suite; this outcome is here for new tests, not for retrofitting existing ones
- [ ] Run `pnpm test:run` on the affected package (`--filter backend` usually)
- [ ] Commit with message `test(req-catalog): rename <file> describes to v4 IDs`

### 4.2 Per-spec-file rename procedure

- [ ] Read §4 Requirements section checkbox-by-checkbox
- [ ] For each checkbox's REQ-ID, verify against v4.md that the described behaviour matches v4's acceptance
- [ ] If match → rename REQ-ID if needed
- [ ] If mismatch → move the bullet to §7 "Out of scope / follow-ups" under a "v4 deviations (ADR-0006)" heading; remove the checkbox (prevents trace from claiming it)
- [ ] Also update §3 user stories, §5 design notes, §6 tasks, §9 REQ→test mapping for internal consistency
- [ ] `pnpm trace` after spec edit to verify no new missing/zombie REQs

### 4.3 auth.ts:105-116 comment replacement (unified diff)

```diff
-  // Hotfix (REQ-022 partial, demo gate): auto-enroll every newly created user
-  // into the seeded 'general' room so a fresh signup can immediately post to
-  // /api/v1/rooms/general/messages without a separate join step. Full REQ-022
-  // (rooms catalog + self-join UI) is S2; this is the minimum wiring for the
-  // S1 demo. Hook API verified in
+  // Auto-enroll every newly created user into the seeded 'general' room so a
+  // fresh signup can immediately post to /api/v1/rooms/general/messages without
+  // a separate join step. NOT a v4 REQ — v4 REQ-022 is "Room description".
+  // This is a permanent non-v4 UX convenience; claimed in s2-rooms.md §7
+  // (non-v4 deviations) and ADR-0006. Covered by register-auto-enroll.test.ts.
+  // It is NOT superseded by v4 REQ-025 (room catalog) / REQ-026 (self-join) —
+  // those enable users to discover and join OTHER rooms; this hook solves the
+  // signup-to-first-message dead-end that would otherwise force every new user
+  // through a manual #general join. Hook API verified in
   // node_modules/.pnpm/@better-auth+core@1.6.5/.../types/init-options.d.mts
```

## 5. Execution order (locked)

1. **Auth tests first** (#2-#11 in the table). Highest drift concentration; most load-bearing for trace signal.
2. **Chat tests next** (#13). Lighter drift, mechanical.
3. **Spec files last** (#1, #12, #14, #15). Read-only to the test code; edits are contained to docs.
4. **auth.ts comment** (#16) — anywhere after #4 (register-auto-enroll rename) so the comment's reference to ADR-0006 is backed by a committed test.
5. **REQ-009 implementation** (§3.2) — after all renames land. Separate commit.
6. **ADR-0006 + FOLLOWUPS updates** (§3.3) — can be written up-front and amended with final deviation list, committed last.

Rationale for auth-first: if the rename rules in §4.1 turn out to need refinement, auth is where we'll hit the edge cases (e.g. the §4.1 outcome C "dual match" case originates in auth). Better to discover this in the worst file than the easiest.

## 6. Testing strategy

- **No new assertions in the rename work.** Renames preserve behaviour.
- **REQ-009 implementation gets its own failing-test-first TDD cycle** per CLAUDE.md §2.
- **Gate: `pnpm test:run` passes after each file's rename batch** — rename one file, run tests, commit, repeat. Prevents large broken state.
- **Gate: `pnpm typecheck` passes** (renames touch strings only; REQ-009 add is typed).
- **Gate: `pnpm trace` passes cleanly** — no `missing` list, no `zombies` list. This is the end-state acceptance gate.

## 7. Risks and mitigations

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Rename breaks a test assertion | low | Each rename touches describe strings only; assertions untouched |
| Rename checklist §4.1 outcome B ("deviation") is over-used, stripping REQ prefixes from tests that should have them | medium | Cross-check outcome B decisions against v4.md before committing; aim for outcome A first |
| ADR-0006 deviation list grows mid-retrofit as new drift surfaces | medium | ADR template reserves a "discovered during retrofit" row-addition process; written last for this reason |
| REQ-009 register rate limit test flakes on testcontainer timing | low | Pattern already validated in rate-limit.test.ts; reuse |
| Total time overruns 3.5h budget | medium | Stop-the-line after #11 (auth tests done) and reassess; auth is the highest-value work |
| `pnpm trace` still fails after retrofit because of a v4 REQ we missed | medium | Run trace with `TRACE_VERBOSE=1` before starting; known-missing list becomes the work list |

## 8. Open questions

All three resolved during review session 2026-04-18:

1. ~~Does `pnpm trace` support allow-list?~~ **No.** Script at [scripts/trace-req-ids.mjs:22-27](../../scripts/trace-req-ids.mjs#L22-L27) extracts REQs from §4 checkbox lines only; deviations living in §7 are invisible to trace. This is the allow-list mechanism.
2. ~~Delete or relabel register-auto-enroll.test.ts?~~ **Relabel.** Describe becomes `"auto-enroll hotfix bridges to v4 REQ-025/REQ-026 self-join"`. File stays (live regression coverage); filename stays (git blame continuity).
3. ~~Phase order?~~ **Locked: auth tests → chat tests → specs → auth.ts comment → REQ-009 impl → ADR+FOLLOWUPS finalization.**

## 9. Decision log

- **2026-04-18 (session 1)** — A′-staged approach initially approved. Phase 1 now, Phase 2 deferred.
- **2026-04-18 (session 2, review)** — Revised to single unified phase. REQ-009 promoted from deviation to in-scope implementation (@fastify/rate-limit already wired; cheap). s2-attachments + s2-afk-presence spec renames added to Phase 1 to prevent "Phase 2 never happens" risk. All §7 open questions locked. Design doc becomes architecture reference; task-level plan to be produced by `writing-plans` skill.
- **2026-04-18 (session 2, post-review)** — REQ-012 locked as outcome B deviation (per-email lockout ≠ per-IP rate limit). §4.1 outcome C example removed (no dual-match case in current tests). Rate-limit.test.ts split question resolved: no split.
- **2026-04-18 (session 2, pre-commit)** — `pnpm trace` baseline run. Result: 45 missing REQs, 0 zombies. 44 of 45 are S2 specs claiming REQs with no code yet (expected). **1 surprise surfaced:** REQ-003 claimed in s1-auth.md §4 R1 has no test reference — retrofit's row #2 rename ([register.test.ts:111](../../apps/backend/tests/register.test.ts#L111) REQ-006 → REQ-003) closes this gap directly. s2-rooms.md discovered (commit ee0b136) — added as row #17 in §3.1. FOLLOWUPS #8 corrected: auto-enroll is permanent per s2-rooms.md R1 `[x]`, not a hotfix slated for deletion. auth.ts:105-116 unified diff in §4.3 rewritten to reflect permanence. FOLLOWUPS #10 added to track v4 REQ-022 ("Room description") as the genuine unimplemented item.
