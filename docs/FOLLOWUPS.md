# Follow-ups — by-stage punch list

A running log of known gaps that are intentionally deferred to a later stage. Each entry names the stage it belongs in, the decision that deferred it, and the code/schema location that should be revisited. This file is how we keep tech debt visible between stages without cluttering the per-stage spec.

Convention: when you land the fix, delete the bullet here AND the matching `TODO(...)` comment in code.

---

## S1 → S2

- ~~**Implement `pnpm trace` REQ-ID coverage check.**~~ Shipped 2026-04-18 in [scripts/trace-req-ids.mjs](../scripts/trace-req-ids.mjs). Strict by default (exits 1 on missing); set `TRACE_VERBOSE=1` for per-REQ coverage, `TRACE_STRICT=1` to also fail on zombie REQ-IDs in tests that no spec §4 claims.

## Batched verification queue (run before next submission-gate checkpoint)

Rationale: heavy smoke checks (docker compose --build, full browser flow) stall feature development when run per-feature. Queue them and run in a single pass after every 2–3 feature merges, or immediately before a submission-gate checkpoint.

- **Docker-compose submission-gate smoke.** `docker compose down -v && docker compose up --build --abort-on-container-exit` from repo root — confirm migrate + seed exit 0, backend logs `Listening on 0.0.0.0:4000`, web serves `/login` with HTTP 200. Last confirmed: before `feat/s1-rooms`. Re-run after: s1-rooms merge + next 1–2 features. Steps codified in [SMOKE.md §1–§2](./SMOKE.md).
- **Manual curl smoke for new write endpoints** (create room + leave room happy/403 per [plans/2026-04-19-s1-rooms.md](./plans/2026-04-19-s1-rooms.md#task-10) Step 5). Integration tests cover the behavior; the curl pass just re-confirms the containerized stack wires auth cookies + route prefix `/api/v1` correctly end-to-end. Low incremental value when tests are green; bundle with the docker smoke above.
- **Playwright multi-browser multi-user** (per `feedback-playwright-multi-user` memory — Chrome + Firefox to exercise concurrent sessions on the same feature). Run at the same checkpoint as the docker smoke so the same running stack serves both.
- **Backend sign-up rate-limit bleed across test files.** Observed merging `feat/s2-room-mgmt-ui`: `tests/room-patch.test.ts` (8) and `tests/room-delete.test.ts` (8) each pass green in isolation, but chained in one vitest fork the second file's sign-up calls return 404/unexpected once better-auth's `customRules["/sign-up/email"]` (5 / 3600s) exhausts. `tests/setup.ts`'s global `flushRedis()` clears the seq+general counters but not better-auth's own rate bucket. Fix shape: either bump `max` in `customRules` when `NODE_ENV === "test"`, or add an `auth.api.clearRateLimits?.()` (or key-prefix flush) call to the beforeEach hook. No production impact — hackathon runs each suite file individually and CI fires one file per worker. Raised 2026-04-19 during S2 room-mgmt merge.
- **In-browser Alice/Bob smoke for S2 room-mgmt** (create room, rename as owner, delete as owner, leave as member, foreign tab receives `room.deleted` and navigates out). Deferred per batched-smoke SOP; fold into the next docker-compose checkpoint.
- **In-browser Alice/Bob smoke for S2 presence** (three-state green/yellow/grey flip within 2s, MemberList pill + Header self-pill). Deferred per batched-smoke SOP; fold into the next docker-compose checkpoint alongside room-mgmt.
- **Pre-existing `packages/shared/src/dto-room.test.ts` vitest-types error.** Present on main before the s2-presence merge; workspace-wide `pnpm typecheck` trips on it while per-workspace typecheck (`pnpm --filter web typecheck`, `pnpm --filter backend typecheck`) is green. Not introduced by presence or room-mgmt. Fix shape: add `vitest/globals` to the `packages/shared` tsconfig `types` or import `describe/it/expect` explicitly in the test file. Raised 2026-04-19 during s2-presence merge.

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

## S2 → S3 (account deletion + GDPR export)

- **Re-register with same email after account delete.** Account delete sets `user.deletedAt` and revokes sessions, but the `user.email` UNIQUE constraint is case-sensitive and better-auth's sign-up validation uses a direct `WHERE email = ?` lookup that does not ignore soft-deleted rows. Net effect: `user@example.com` can delete their account, but the same email cannot be re-used by a new sign-up — it collides on email even though the account is gone. Acceptable for a 24h event; users reach a "sign-up conflict" state, not a corruption state.
  - **Fix shape**: either (a) hard-overwrite `email`/`username` to a tombstone (e.g. `deleted-<uuid>@tombstone.invalid`) on soft-delete so the original strings become free (preferred — messages still render correctly because `message.authorUsername` is a send-time snapshot), or (b) add a partial UNIQUE(email) WHERE deletedAt IS NULL index and teach better-auth's sign-up path to ignore deleted rows.
  - **Location**: `apps/backend/src/routes/account.ts`, `packages/shared/src/schema.ts` user table.
  - **Raised**: 2026-04-19 during S2 implementation.

- **Attachment cleanup on account delete.** When a user deletes their account we soft-delete `user`, hard-cascade `friendship`/`friend_request`/`user_block`/`room_member`, and leave `message` rows intact (REQ-018 — messages keep rendering with "[deleted user]"). Attachments referenced by those messages keep their bytes on disk + their DB rows. Over a multi-month horizon this is storage debt; over 24h it's invisible. The S3 GC job already queued under "S2 → S3 attachment orphan GC" can be extended to scan `message.authorId IN (SELECT id FROM user WHERE deletedAt IS NOT NULL)` with a retention window (e.g. 30 days post-delete) if the product later requires true erasure of attachment bytes.
  - **Location**: `apps/backend/src/routes/account.ts`, `packages/shared/src/schema.ts` attachment table.
  - **Raised**: 2026-04-19 during S2 implementation.

- **Export download uses client-generated filename.** The export endpoint sets `Content-Disposition: attachment; filename="…"`, but cross-origin browsers hide that header from JS unless the server lists it in `Access-Control-Expose-Headers`. Our fetch-based download helper reads the header and, when missing, falls back to `user-data-export-<timestamp>.json` (prefix-aligned with the backend-proposed name but missing the `<username>` segment because the client doesn't have it cheaply at this call site). The download works; the filename is just a little less descriptive than the server-proposed one. Fix: add `"content-disposition"` to the `exposedHeaders` list in the backend CORS config.
  - **Location**: `apps/backend/src/plugins/cors.ts` (or wherever `@fastify/cors` is registered), `apps/web/src/lib/account-api.ts` (reads the header).
  - **Raised**: 2026-04-19 during in-browser verification of the S2 flow.

## Out of hackathon scope (referenced so reviewers don't flag as missing)

- **Username change (REQ-127)** — explicitly deferred in `docs/BRIEF.md`.
- **Email verification at signup** — `requireEmailVerification: false`; `user.emailVerified` column stays for better-auth compatibility but is always `false`. `docs/specs/s1-auth.md` §5.
- **Admin "force logout all users" tooling** — not in the REQ range.
- **XMPP federation (v3.docx §6 / REQ-180 range).** Deliberately deferred per [ADR-0002](adr/0002-no-xmpp.md). The MVP ships a façade at `/admin/federation` + [docs/FEDERATION.md](./FEDERATION.md) documenting the full enable path (Prosody + `mod_s2s` + custom Postgres storage module). Reason for deferral: TLS/DNS prerequisites exceed the 52h window and a half-shipped s2s daemon risks the `docker compose up` submission gate. Architecture is bridge-ready; the deferral is a scope call, not tech debt.

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

## Wave A smoke residuals (2026-04-19)

Surfaced during manual verification of the Wave A merge set (s4-facade + s2-room-mgmt-ui + s2-presence + s2-account-gdpr) on `verify/wave-a-smoke`. All five submission-gate checks completed; four pass outright, one (presence UI) is green at the socket-protocol layer but broken at the member-list render layer. These items are intentionally deferred per the smoke brief's "no protocol changes" fence.

- **Room-member roster endpoint missing — presence pills for non-self members never hydrate.** `apps/web/src/app/rooms/[roomId]/RoomClient.tsx:41-45` hardcodes `SEEDED_OTHER_MEMBERS` with placeholder ids (`"user-alice"`, `"user-bob"`, `"user-carol"`). The self entry is spliced in at render with the real session user id, so the viewer's own pill reacts to `presence.changed`. Every other member's pill is bound to a placeholder id that no real event will ever carry, so Bob/Carol always render "offline" in Alice's Members panel even when they are online and announcing. Verified end-to-end from Bob's side via [apps/web/bob-trigger.mjs](../hackathon-starter/apps/web/bob-trigger.mjs) + a socket.io-client observer: server emits `presence.changed` with real UUIDs at spec timings (instant on activity, 60s idle→away, 2s debounce on offline), and `apps/web/src/lib/presence-store.ts` receives them, but no mounted `PresencePill` subscribes to the real UUID.
  - **Fix shape**: add `GET /api/v1/rooms/:id/members` that returns `{ id, username, displayName }[]` sourced from `room_member` join `user`; call it in `RoomClient.tsx` alongside the history fetch; replace `SEEDED_OTHER_MEMBERS` with the real roster. Alternative (protocol change): extend the `room.subscribe` ack to include the roster so one round-trip covers both join + member list.
  - **Location**: `apps/web/src/app/rooms/[roomId]/RoomClient.tsx:41-45` (placeholder array) + `apps/web/src/components/chat/MemberList.tsx` (consumer); new backend route in `apps/backend/src/routes/rooms.ts`.
  - **Raised**: 2026-04-19 during Wave A smoke. Socket-protocol layer is correct; fix is UI hydration only.
  - **Status**: in-flight — picked up as the v0.2 demo unblocker ("alice AFK → bob sees yellow"). Not touched by the docs-reconcile pass so the owning agent doesn't hit merge conflicts.

- ~~**Account-delete UX: password-confirm vs type-to-confirm drift.**~~ Resolved 2026-04-19 in `docs/specs/s2-account-gdpr.md` §5 — password-confirm is canonical. Implementation was already password-confirm (`apps/web/src/app/settings/account/page.tsx` dialog body); the drift was the early-agent brief's "Type DELETE" proposal, which the spec now explicitly rejects. Password re-auth proves identity (not just intent) and reuses better-auth's existing password check, so it's strictly stronger than a string-match gate.

- ~~**Export endpoint verb/path docs drift.**~~ Resolved 2026-04-19. `POST /api/v1/users/me/export` is the only form present across `docs/specs/s2-account-gdpr.md`, the protocol DTO comment, and the backend route. A grep across `docs/` for the stale `GET /api/v1/account/export` / `GET /users/me/export` shapes came up empty outside the self-describing FOLLOWUPS entry, which is now removed.

- ~~**Export filename pattern drift.**~~ Resolved 2026-04-19. Client fallback in `apps/web/src/lib/account-api.ts` now generates `user-data-export-<timestamp>.json`, matching the backend prefix (the backend still adds `<username>` when the header is exposed). Spec §5 documents the observed shape. Remaining work (CORS `exposedHeaders`) stays queued under "Export download uses client-generated filename" above.

- **Durable Playwright specs for Wave A gates (deferred).** Wave A ran as manual Playwright MCP passes. Gates 1/2/4/5 are stable surfaces with high regression risk and are good candidates for `tests/e2e/` specs that rerun at each submission-gate checkpoint. Wave B/C should inherit the test, not the MCP transcript.
  - **Fix shape**: four specs under `tests/e2e/` — (a) auth + room create/invite/rename/delete (Gate 2), (b) account export + delete + `[deleted user]` substitution (Gate 4), (c) federation façade admin page + 403 for non-admin (Gate 5), (d) docker-compose health smoke as a `pnpm test:e2e:smoke` runner that only hits `/health` and `/login`. Skip a UI presence-pill spec until the roster endpoint above lands — it would just encode the current bug. The existing seeded users (alice/bob/carol @herders.local / `hunter2hunter2`) cover auth setup; use separate `BrowserContext`s per role rather than Chrome+Firefox since the concurrency constraint was specific to Playwright MCP, not headless Playwright.
  - **Location**: new files in `tests/e2e/`; Playwright is already wired (`pnpm test:e2e` command from CLAUDE.md).
  - **Raised**: 2026-04-19 at end of Wave A smoke; explicitly accepted as scope creep by the human during the smoke pass.
