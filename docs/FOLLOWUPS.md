# Follow-ups — by-stage punch list

A running log of known gaps that are intentionally deferred to a later stage. Each entry names the stage it belongs in, the decision that deferred it, and the code/schema location that should be revisited. This file is how we keep tech debt visible between stages without cluttering the per-stage spec.

Convention: when you land the fix, delete the bullet here AND the matching `TODO(...)` comment in code.

---

## S1 → S2

- ~~**Implement `pnpm trace` REQ-ID coverage check.**~~ Shipped 2026-04-18 in [scripts/trace-req-ids.mjs](../scripts/trace-req-ids.mjs). Strict by default (exits 1 on missing); set `TRACE_VERBOSE=1` for per-REQ coverage, `TRACE_STRICT=1` to also fail on zombie REQ-IDs in tests that no spec §4 claims.

## S2 → S3

- **Attachment orphan GC.** `packages/shared/src/schema.ts` keeps `attachment.messageId` nullable so files can be uploaded in step 1 of a 2-step "upload → send message with references" flow. If step 2 never happens (client crash, abandoned tab, rejected send), the file sits in `UPLOAD_DIR` + the DB row lingers forever. At 300 concurrent users for 24h it's negligible; at S3-hardening time we want a sweep.
  - **Location**: `packages/shared/src/schema.ts` attachment table (`TODO(S3-GC)` comment on the `messageId` column).
  - **Fix shape**: a periodic Fastify task (or a Redis-scheduled job) that deletes rows + files where `messageId IS NULL AND createdAt < now() - INTERVAL '1 hour'`.
  - **Raised**: 2026-04-18 during S1 spec review.

## S3 — hardening / pre-ship

- **SMTP for password-reset email (REQ-019 completion).** Today the reset token is logged (redacted in prod per task #7); no mail is sent. Wire nodemailer/SES. `docs/specs/s1-auth.md` §7 tracks it.
- **Distributed rate-limit storage.** Move better-auth's `rateLimit` from in-memory to Redis so it survives backend restarts and scales across replicas. `docs/specs/s1-auth.md` §7.
- **CSRF double-submit token (REQ-146).** S3 layer — better-auth's same-site cookie + origin-check suffices for S1/S2. `docs/specs/s1-auth.md` §7.
- ~~**Password change UI + "revoke all other sessions on password change".**~~ Shipped 2026-04-19 on `feat/s1-residual` as REQ-016: `/settings/password` page with current/new/confirm-new + "Sign out other sessions" checkbox (default on); posts to `/api/auth/change-password`; linked from Header. Covered by `apps/backend/tests/password-change.test.ts`.

## Out of hackathon scope (referenced so reviewers don't flag as missing)

- **Account deletion / soft-delete cascade** — `user.deletedAt` exists in schema but no deletion flow is wired. v3.docx §2.1 defers it.
- **Username change (REQ-127)** — explicitly deferred in `docs/BRIEF.md`.
- **Email verification at signup** — `requireEmailVerification: false`; `user.emailVerified` column stays for better-auth compatibility but is always `false`. `docs/specs/s1-auth.md` §5.
- **Admin "force logout all users" tooling** — not in the REQ range.

## ADR-0006 deviations (2026-04-18 retrofit)

Tracked deferrals from the v4 REQ-catalog retrofit. Each item has a pointer to where it currently lives and what shipping it would cost.

1. **REQ-003 — case-insensitive email uniqueness.** Current test `register.test.ts` exercises case-sensitive path. Add a case-variation test when better-auth 1.6.5+ lowercasing is wired.
2. **REQ-005 — case-insensitive username uniqueness.** Same pattern as #1.
3. **REQ-006 — password policy (12-char + top-10k blocklist).** Note: all test fixtures + seed use `"password1234"` which is on the blocklist; any implementation MUST rewrite fixtures in lockstep.
4. ~~**REQ-007 — passwordConfirm field.**~~ Shipped 2026-04-19 on `feat/s1-residual`: optional `passwordConfirm` + `.superRefine` in `packages/shared/src/dto.ts`; second password input on `apps/web/src/app/register/page.tsx`. Optional (not required) so the ~88 existing backend-test sign-up call sites keep working without a mechanical sweep; mismatch rejection is the contractual behaviour and is covered by `apps/backend/tests/register-validation.test.ts` REQ-007 describe block.
5. **REQ-008 — argon2id.** Written justification lives in [docs/adr/0009-no-argon2id.md](adr/0009-no-argon2id.md): better-auth 1.6.x hashes with scrypt via a non-pluggable `node:crypto` path; swapping to argon2id means unwinding ADR-0001 (stack pivot). Accepted deviation at the v3.docx §8 threat-model level. No test covers REQ-008; the ADR IS the artifact.
6. **REQ-009 — /24 subnet rate limit.** Custom keyGenerator in `@fastify/rate-limit`; CIDR math; deferred (per-IP rule IS implemented, see `auth.ts` customRules).
7. **REQ-012 — per-email lockout.** Current `rate-limit.test.ts` exercises IP-scoped 429 only; per-email counter + `auth_locked` error code are S3 work (see ADR-0006 row).
8. **Auto-enroll is permanent, not a hotfix.** `auth.ts:117-143` + `register-auto-enroll.test.ts` stay indefinitely per s2-rooms.md R1 `[x]` (commit `ee0b136`). No deletion when S2 rooms (v4 REQ-025/REQ-026) land.
9. **s1-chat REQ-049 seed.** Seed script is demo infra, not a v4 REQ. Trace doesn't need to claim it.
10. **v4 REQ-022 "Room description".** Not implemented. `room.description` column exists in `packages/shared/src/schema.ts`, but there is no UI or API enforcement of description format/length/visibility. Deferred until a future spec claims it in §4.
11. ~~**REQ-037 — offline-to-online message backfill.**~~ Closed 2026-04-19 on `feat/s1-residual` by the integration test `apps/backend/tests/req-037-backfill.test.ts`. The existing watermark protocol (ADR-0003) + history API satisfy the REQ without new production code: on reconnect a client compares `subscribe.ack.roomHeadSeq` against its last-seen seq and backfills via `GET /api/v1/rooms/:id/messages?fromSeq=<lastSeen+1>&toSeq=<head>`.
