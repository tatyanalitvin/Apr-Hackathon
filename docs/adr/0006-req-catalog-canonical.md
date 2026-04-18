# ADR-0006 — REQ-ID catalog: v4.md is canonical

## Status

Accepted — 2026-04-18.

## Context

- `task/Chat_Server_Requirements_v4.md` is the external prep catalog with rigorous per-REQ acceptance criteria (~195 REQs).
- S1 specs (`s1-auth.md`, `s1-chat.md`) initially used a drifted internal REQ-ID scheme. S2 stubs (`s2-attachments.md`, `s2-afk-presence.md`, `s2-rooms.md`) continued the drift.
- `pnpm trace` (`scripts/trace-req-ids.mjs`, commit `604aed5`) has no allow-list: it extracts REQs from spec `§4` checkboxes and fails on any with no test reference. Drift is actively costly.
- Audit session 2026-04-18 identified drift in `s1-auth.md`, `s1-chat.md`, `s2-attachments.md`, `s2-afk-presence.md`, `s2-rooms.md` (s1-web, s2-friendship, s2-dms were already aligned).

## Decision

`task/Chat_Server_Requirements_v4.md` is the single source of truth for REQ-IDs across specs, tests, and code comments. Specs claim a REQ via a `§4` checkbox only when a test genuinely covers the v4 acceptance. Deferrals and deviations live in `§7` "Out of scope / follow-ups" with a link back to this ADR.

Test `describe`/`test` names embed the v4 REQ-ID verbatim. Where a test exercises real behaviour that doesn't map to any v4 REQ, the `REQ-` prefix is stripped and the describe includes a plain-English summary plus a `(deviation from v4 REQ-NNN, see ADR-0006)` cross-reference.

Any new REQ-ID introduced in future work MUST reference v4; inventing an ID is a bug.

## Accepted deviations (S1 scope, hackathon timebox)

| v4 REQ | v4 rule | Our implementation | Rationale | Revisit |
| --- | --- | --- | --- | --- |
| REQ-003 | Case-insensitive email uniqueness | Case-sensitive via better-auth default | S3 hardening | S3 |
| REQ-005 | Case-insensitive username uniqueness | Case-sensitive | Same as REQ-003 | S3 |
| REQ-006 | 12-char min + top-10k blocklist | 8-char min, no blocklist | better-auth default. **Test fixtures use `password: "password1234"` across register.test.ts, login.test.ts, schemas.test.ts, and seed.ts — this value IS on v4's top-10k blocklist. If REQ-006 is ever implemented, every fixture breaks.** | S3 |
| REQ-007 | `passwordConfirm` field | No confirmation field | UI is test-after; single-password UX OK for demo | S3 |
| REQ-008 | argon2id (memoryCost=19456, timeCost=2) | scrypt via better-auth 1.6.5 default | ADR-0001 pivot rationale; changing here unwinds better-auth adoption | S3 or never |
| REQ-009 `/24` subnet rule | 20 registrations per /24 per hour | Per-IP rule only (5/IP/hr) via `@fastify/rate-limit` customRule | Custom keyGenerator + CIDR math, not mechanical. Per-IP rule IS honoured (see `apps/backend/src/auth.ts` customRules + `register-rate-limit.test.ts`) | S3 |
| REQ-012 | Per-email lockout (10 fails/15min, code `auth_locked`) | Per-IP rate limit (5 fails/60s, 429) | IP rate limit is weaker — botnet bypasses it. Per-email lockout requires a new counter store keyed by email + `auth_locked` error wiring through better-auth's login handler. Not mechanical. | S3 |
| REQ-022 (ghost) → formal non-v4 deviation | v4 REQ-022 = "Room description" (unimplemented) | `auth.ts:117-143` auto-enrolls new users into `general`; covered by `register-auto-enroll.test.ts`; claimed in `s2-rooms.md §7` (non-v4 deviations) | **Permanent** non-v4 UX convenience (per commit `ee0b136` shipping s2-rooms.md R1 `[x]`). Prevents the signup-to-first-message dead-end without forcing a manual `#general` join. v4 REQ-022 "Room description" proper is a separate, deferred item (see FOLLOWUPS.md #10). | never |
| REQ-004 | `[A-Za-z0-9_]{3,24}` username regex | `[A-Za-z0-9_]{3,32}` | Wider limit was set before v4 tightening; no known collision risk | S3 |
| `GET /rooms/me` (s2-rooms R4) | No v4 REQ | Endpoint returns caller's memberships | Non-v4 endpoint; closest v4 REQ is REQ-020 (data model) | never |

## Consequences

- `FOLLOWUPS.md` contains one actionable entry per deviation row.
- `pnpm trace` is green because deviations live in `§7`, not `§4` checkboxes.
- Test describes for deviations strip the `REQ-` prefix and reference ADR-0006 inline.
- The rename-phase touched: s1-auth.md, s1-chat.md, s2-attachments.md, s2-afk-presence.md, s2-rooms.md, and 12 backend test files (register, schemas, register-auto-enroll, sessions-list, sessions-revoke, login, logout, rate-limit, password-reset-request, account-delete, messages-*, socket-*). See the implementation plan at `docs/plans/2026-04-18-req-catalog-v4-retrofit-plan.md` for per-file diffs.
