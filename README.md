# AI Herders Jam — Online Chat Server

> A self-hosted classic web chat server that runs with one command: `docker compose up`.

## What it is

Hackathon submission for **AI Herders Jam** (2026-04-18): accounts, public/private rooms, DMs, contacts, file sharing, moderation and persistent history, designed for up to 300 concurrent users. Built in 52 hours by one QA engineer + Claude Code Opus 4.7, spec-first and test-driven, following the v3.docx organizer brief. Full scope and stage plan in [docs/BRIEF.md](docs/BRIEF.md).

## What's shipped

Every MUST REQ in the v3.docx brief is closed or has an accepted ADR deviation. Scope at a glance — **11 backend route files, 11 SQL migrations, 121 backend integration test files, 26 Playwright e2e specs, 25 feature specs, 9 ADRs**:

- **Auth & identity** — better-auth stack on scrypt; registration with 12-char minimum + SecLists top-10k blocklist (REQ-006, [password-blocklist.ts](apps/backend/src/lib/password-blocklist.ts)); passwordConfirm (REQ-007); case-insensitive email + username uniqueness (REQ-003/005, migration 0010); /24 sign-up rate-limit on IPv4 + /64 on IPv6 (REQ-009, [register-rate-limit.ts](apps/backend/src/lib/register-rate-limit.ts)); password reset token flow + password-change page with "revoke other sessions" (REQ-016/019); session list + per-session revoke (REQ-017/018, `/settings/sessions`); CSRF double-submit (REQ-146, [csrf.ts](apps/backend/src/lib/csrf.ts)); account delete with tombstoning + re-register with same email; GDPR data export.
- **Rooms** — create (public/private + description + visibility), join / leave, rename, delete, PATCH metadata with `room.updated` fanout, member list, member cap (REQ-028); seeded `general` room + auto-enroll on signup; REQ-022 description + REQ-028 1000-char cap.
- **Moderation** — role model (owner / admin / member, migration 0007), promote / demote / kick / ban / unban, dual-socket force-leave on kick (REQ-208), per-action rate-limit with dual-tier Redis counters ([room-moderation-rate-limit.ts](apps/backend/src/lib/room-moderation-rate-limit.ts)), admin message delete (REQ-212), tombstone rendering.
- **Messaging** — send / edit / delete, replies + reply-preview ([reply-preview.ts](apps/backend/src/lib/reply-preview.ts)), emoji picker with splice-at-caret, mutes with `muted_until` (migration 0006), read receipts, per-room monotonic `seq` watermark ([ADR-0003](docs/adr/0003-watermark-protocol.md)), offline → online backfill via history API (REQ-037), DM as `room.kind='dm'` ([ADR-0007](docs/adr/0007-dm-as-room.md)), DM unread parity with group rooms, reconnect gap-detect.
- **Attachments** — multipart upload, download with 403 probe-oracle suppression, image inline preview, file chips with italic comment captions (REQ-E-UI-LIST-COMMENT), paperclip button (REQ-213), orphan GC + tombstoned-user GC every 15 min ([attachment-gc.ts](apps/backend/src/lib/attachment-gc.ts)).
- **Contacts & friendship** — invite / accept / decline, block / unblock, user search, friend rate-limit ([friend-rate-limit.ts](apps/backend/src/lib/friend-rate-limit.ts)).
- **Invitations** — room invites with 24h expiry, accept / decline / cancel, inbox pane, lazy-GC at read-time, ban-aware gate (migration 0008 `room_invite`).
- **Presence** — three-state online / AFK / offline, member-list pills, header self-pill, AFK suffix (REQ-215); Socket.IO + Redis adapter for cross-replica fanout.
- **Admin & federation** — `/admin` + `/admin/federation` façade page with 403 for non-admin; XMPP deliberately deferred as documented façade per [ADR-0002](docs/adr/0002-no-xmpp.md) + [docs/FEDERATION.md](docs/FEDERATION.md).
- **Infra & test discipline** — Drizzle schema + 11 hand-edited migrations; `pnpm trace` REQ-ID coverage check (strict-by-default, fails on missing MUST REQs); Redis-backed distributed rate-limit storage (pulled forward from S3); [CLAUDE.md](CLAUDE.md) + 25 feature specs + 9 ADRs keeping the decision trail.

## Status at handoff (2026-04-20)

Submission gate (`docker compose up`) is green, backend integration tests are green, working tree is clean on `main`. Two caveats before you read further, and a punch-list of what's left.

- **Scope vs. time.** The v3.docx brief is a full classic chat server (accounts, rooms, DMs, contacts, file sharing, moderation, 300 concurrent users). It is **not** an 8-hour build — even at 52h the schedule was tight, and the spec itself was thin in places (Q&A had to fill real gaps mid-event: invitation rate-limit / GC policy, account-delete confirmation, export filename shape, CSRF trust-boundary, /24 vs /32 rate-limit layering). Breadth over polish was the deliberate call.
- **UI is intentionally unpolished.** This version ships the structural pass only — layouts, a11y landmarks, lavender-mist palette, masonry rooms-browse, AI message variant. No visual-design iteration. Don't read rough edges as bugs unless they break a REQ.

**Open items: 22.** Full detail (file pointers, commit provenance, fix shapes) in [docs/FOLLOWUPS.md](docs/FOLLOWUPS.md). Summary:

| Group | Count | Examples |
| --- | --- | --- |
| Actionable code work | 4 | SMTP password-reset (REQ-019), S3 per-route rate-limit sweep, REQ-012 per-email login lockout (6 × `test.todo` in place), invitation Q4/Q5 (50/24h inviter RL + `pending → expired` GC) |
| Batched smoke / e2e queue | 13 | Docker + curl smoke, multi-browser multi-user, Alice/Bob UI sweeps for S2 room-mgmt / presence / invitations / sessions / REQ-208 / catalog+emoji / REQ-212-213-215, Wave A durable specs, invitations dual-browser wiring |
| Parked test flakes | 2 | Parallel-DB FK-race residual (host-thrash symptom), `rooms-create` + `attachments-upload` + `rooms-join-rate-limit` parallel-fork flake |
| Log-and-park / accepted deviations | 3 | REQ-008 argon2id ([ADR-0009](docs/adr/0009-no-argon2id.md)), auto-enroll permanence, REQ-049 seed is demo infra |

Explicitly out of hackathon scope (listed in FOLLOWUPS so reviewers don't flag as missing): username change (REQ-127), email verification at signup, admin force-logout-all, XMPP federation ([ADR-0002](docs/adr/0002-no-xmpp.md) — façade shipped per [docs/FEDERATION.md](docs/FEDERATION.md)).

If you're picking this up: read [CLAUDE.md](CLAUDE.md) first, then pick an item from group 1 — every item already has a spec in [docs/specs/](docs/specs/) or an ADR in [docs/adr/](docs/adr/).

## Quick start (clone → demo in ≤30s on a warm machine)

Prereqs: Docker Engine 24+ with Compose v2; host ports `3000`, `4000`, `5432`, `6379` free.

```bash
# 1. Nuke any prior state (first run on a fresh clone is a no-op).
docker compose down -v

# 2. Build images and start detached. First run pulls base images + installs
#    deps; expect 2–4 minutes on a warm network, 30–60 seconds thereafter.
docker compose up --build -d

# 3. Wait for all services to report healthy. Postgres + Redis come up fast;
#    backend depends on `migrate` completing, so the first run adds ~3s for
#    drizzle-kit to apply `infra/migrations/*.sql`.
docker compose ps
# Expected: postgres (healthy), redis (healthy), backend (healthy), app (Up),
#           migrate (Exited 0).

# 4. Seed the demo fixture (REQ-049). Press Ctrl-C after "[seed] done".
docker compose exec backend pnpm db:seed
```

Web UI at <http://localhost:3000>, backend at <http://localhost:4000>. For the backend REST smoke (register / sign-in / send message / fetch history), see [docs/SMOKE.md](docs/SMOKE.md).

## Seed users

The seed script (REQ-049) creates three users, all sharing password `hunter2hunter2`, all pre-enrolled in the `general` room:

| Username | Email | Role in demo |
| --- | --- | --- |
| `alice` | `alice@herders.local` | Driver (left browser) |
| `bob` | `bob@herders.local` | Receiver (right browser) |
| `carol` | `carol@herders.local` | Silent member, proves multi-user presence |

## Two-browser demo

Open **two browsers** (e.g. Chrome + Firefox — one cookie jar per browser is required for concurrent identities) side-by-side at <http://localhost:3000>:

1. **Left browser** — register a brand-new account; auto-enrolled into `general`, which already contains `bob` and `carol`.
2. **Left** — send `hello` in `general`.
3. **Right browser** — sign in as `bob`; the message renders in <1s.
4. Left → add bob as friend from the member panel; right → accept.
5. Open a DM; left drags a photo into the composer; right sees it inline.
6. Left opens a second tab and goes AFK; right's member panel shows the green dot turn yellow within 2s.
7. Left mutes `general` from the room header; tab title stops showing unread count.

Every step above is covered by a `REQ-###` Playwright test — see `tests/e2e/`.

## Stack

Next.js 15 + React 19 + TypeScript · Tailwind + shadcn/ui · Fastify sidecar · Socket.IO (+ Redis adapter, per-room monotonic `seq` watermark) · Postgres 16 + Drizzle ORM · better-auth · local-FS file storage · docker compose.

## Federation

S4 XMPP federation is a documented façade, not a built feature — see [docs/FEDERATION.md](docs/FEDERATION.md) and [ADR-0002](docs/adr/0002-no-xmpp.md) for the architecture and the scope decision.
