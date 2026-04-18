# AI Herders Jam — Online Chat Server (working brief)

> **Source of truth for scope:** the v3 docx in `/Users/littlewin/Work/2026-Apr-Hackaton/task/2026_04_18_AI_herders_jam_-_requirements_v3.docx` is the organizer's brief. The v4 markdown files in that folder are AI-generated pre-work and are used here as **acceptance-criteria reference** (stable `REQ-###` IDs for traceability) — not as binding requirements.
>
> **Submission gate (the only hard organizer rule):** public GitHub repo + `docker compose up` from repo root produces a working system.

## The problem in one sentence

Build a classic web chat server — accounts, public/private rooms, DMs, contacts, file sharing, moderation, message history, online presence — usable at 300 concurrent users.

## What we're shipping (stage plan)

We build in four stages. Every stage is runnable, demoable, testable on its own. Each REQ-ID cited below comes from `/task/Chat_Server_Requirements_v4.md`; we use them verbatim as test names for traceability (`describe("REQ-031 unicode hygiene", ...)`).

### Stage 1 — Walking Skeleton (`REQ-001` … `REQ-049`) — hard gate at H+8

One public room, plain-text messaging, two-browser live demo, persistent history, `docker compose up` green.

Scope:

- Register (REQ-001 … REQ-009): email + username + confirm-password, case-insensitive uniqueness, 12-char min password, bcrypt cost-12 hash (we deviate from argon2id — ADR-0001 captures why: GoTrue default).
- Login (REQ-010 … REQ-019): keep-me-signed-in, 10-fail lockout, session list, single-session revoke, all-sessions-revoke on password change.
- Rooms (REQ-021 … REQ-028): public only in S1, 1000-member cap, catalog with search + cursor pagination.
- Messages (REQ-029 … REQ-037): plain text 1–4096 bytes, NFC-normalized, monotonic `seq` per room, clientMessageId dedup, broadcast over Supabase Realtime.
- Realtime (REQ-038 … REQ-041): WebSocket auth + heartbeat + subscriptions; binary online/offline presence.
- Frontend (REQ-042 … REQ-048): `/register`, `/login`, `/rooms`, `/rooms/:id`; three-column ≥1024px, collapses below; Enter sends, Shift+Enter newline, autoscroll, infinite-scroll up.
- Deployment (REQ-049): docker compose, seed script with `alice`/`bob`/`carol` + `general` room, CI green.

### Stage 2 — Full chat (selective, `REQ-050` … `REQ-139`) — soft gate at H+16

Ship the S2 REQs that make the demo visibly richer; skip the compliance surfaces.

In: contacts (REQ-050 … REQ-060), DMs (REQ-061 … REQ-066), user-to-user ban (REQ-073, REQ-074), attachments (REQ-075 … REQ-085), private rooms + invitations (REQ-088, REQ-089), admin/owner role matrix (REQ-092 … REQ-095), AFK presence (REQ-099 … REQ-105), replies + edit + delete (REQ-110 … REQ-114), unread + mute (REQ-120 … REQ-124), room ownership transfer + delete (REQ-086, REQ-087).

Out: full moderation-log UI beyond read-only view, data export (REQ-126), username rectification (REQ-127), extended keyboard shortcuts (REQ-138), typing indicator if time pressured.

### Stage 3 — Visible hardening (selective, `REQ-140` … `REQ-179`) — H+18 to H+21

Ship the things judges can see; skip operational plumbing.

In: CSP + HSTS (REQ-149, REQ-150), CSRF double-submit (REQ-146), rate limiter (REQ-147), signed file URLs (REQ-151 — free with Supabase Storage), `/admin` dashboard with live metrics (REQ-158), one k6 load-test run screenshot (REQ-143).

Out: full password-reset email delivery (REQ-144 — stays stub from REQ-017), nightly backup runbook (REQ-152), SMTP config (REQ-164), scheduled GC jobs (REQ-163).

### Stage 4 — Federation façade (`REQ-180` … `REQ-209`) — H+21 to H+23

**Not built. Intentionally.** We ship a `/admin/federation` status page ("configure `XMPP_DOMAIN` to enable") and `docs/FEDERATION.md` documenting the Prosody bridge architecture. ADR-0002 captures why: XMPP↔Supabase bridging is half the S4 effort budget of the spec and does nothing for the chat demo judges see. We read the spec; we scoped it; we documented that choice.

## Demo moment (the single "wow")

Two browsers side-by-side:

1. Alice registers + logs in; sees `general` room with bob + carol already inside.
2. Alice sends "hello" → bob's browser renders it in <1 second.
3. Alice adds bob as friend from the room member panel; bob accepts.
4. They open a DM; alice uploads a phone photo via drag-drop; bob sees it inline.
5. Alice opens a second tab and goes AFK; bob's member panel shows alice turn from green to yellow within 2 seconds.
6. Alice mutes the room from the `general` header; browser tab title stops showing unread count.

Everything the demo shows is covered by a REQ-ID test.

## Out of scope / deferred

- XMPP / Jabber / S2S federation (S4 façade only, see above).
- GDPR username rectification workflow (REQ-127).
- Data export (REQ-126).
- Full email delivery for password reset (REQ-144 stays S1-stub behavior).
- Nightly backup / PITR / GC jobs (REQ-152, REQ-159, REQ-163).
- Security event log UI (REQ-165 — events are written, no admin screen).
- Account legal-hold (REQ-160).

## Stack (binding for this project)

- **Framework:** Next.js 15 App Router + React 19 + TypeScript strict + pnpm workspaces + Node 20.
- **UI:** Tailwind + shadcn/ui.
- **DB:** Postgres 16 + **Drizzle ORM** (schema as single source of truth in `packages/shared/src/schema.ts`).
- **Auth:** **better-auth** — native sessions-list API (v3.docx §2.2.4), keep-me-signed-in, rate-limited login, password reset/change.
- **Realtime:** **Socket.IO** with Redis adapter — rooms, presence, reconnect, acks. Per-room monotonic `seq` watermark for gap detection.
- **Backend sidecar:** Fastify — atomic `seq` allocation on message insert, rate limits, file upload/download (local-FS per v3.docx §3.4), moderation audit log.
- **Cache / pubsub:** Redis — Socket.IO adapter, rate-limit counters, unread-count fanout.
- **Shared:** zod DTOs + Socket.IO event types + watermark protocol in `packages/shared/`.
- **Tests:** Vitest + Supertest + Playwright + k6 for load.

## Traceability convention

Every automated test's `describe` or `test` name MUST contain the REQ-ID it covers. Example: `test("REQ-047 autoscroll only at bottom", ...)`. CI runs `pnpm run trace` which greps `tests/` for each REQ-ID the spec marks MUST and fails the build if any are missing.
