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
- **Password change UI + "revoke all other sessions on password change".** Endpoint exists in better-auth (`auth.api.changePassword`); S1 doesn't surface it. `docs/specs/s1-auth.md` §7.

## Out of hackathon scope (referenced so reviewers don't flag as missing)

- **Account deletion / soft-delete cascade** — `user.deletedAt` exists in schema but no deletion flow is wired. v3.docx §2.1 defers it.
- **Username change (REQ-127)** — explicitly deferred in `docs/BRIEF.md`.
- **Email verification at signup** — `requireEmailVerification: false`; `user.emailVerified` column stays for better-auth compatibility but is always `false`. `docs/specs/s1-auth.md` §5.
- **Admin "force logout all users" tooling** — not in the REQ range.
