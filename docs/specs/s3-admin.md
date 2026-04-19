# Spec: S3 — Admin dashboard (live metrics surface)

**Status**: in-progress (2026-04-19)
**Branch**: `feat/s3-admin` (worktree: `../hackaton-s3-admin/`, off `main` at `a310c30`)
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code — S3 admin agent (pairs with `s3-hardening` for the security-event feed)
**Scope**: v4 REQ-158 (operator monitoring surface). Binding brief: `.human/S3_ADMIN_AGENT_BRIEF.md` §§1, 3, 4, 7.

## 1. Why

Judges read `/admin` during the live demo. The hackathon brief (§ "success = judge-visible live metrics") requires a page that shows, at a glance, whether the chat server is healthy under 300 concurrent users. The four widgets below are the smallest set that answers "is it working, and are attackers being stopped?".

This spec also locks the cross-agent contract with the parallel `feat/s3-hardening` branch: the hardening agent imports `recordSecurityEvent({ type, ip, route })` from our `apps/backend/src/lib/metrics.ts`. Locking the export signature here lets them land independently and merge without a race.

## 2. Non-goals

- **Persistent metric storage (Redis, Prometheus, etc.)** — in-memory ring buffers only. Single-process for the hackathon demo; horizontal-scale is a follow-up.
- **Chart libraries (Recharts / D3 / Chart.js)** — plain HTML + CSS bars. No new UI deps.
- **Role-based access control refactor** — `ADMIN_USER_IDS` env CSV is the entire auth gate.
- **Websocket push of metrics** — poll every 2s. 4 widgets × 2s ≠ the sort of load that needs push.
- **Audit log persistence** — the security-event feed is an in-memory ring of the last 50 events. No DB table.

## 3. User stories

- As the operator (alice), I visit `/admin` and see online users, messages/minute, a 5-min 5xx count, and the last 50 security events.
- As a non-admin user (bob), I visit `/admin` and see "Forbidden" — no metrics leak.
- As a logged-out visitor, I visit `/admin` and see "You must sign in".
- As the S3-hardening agent, I `import { recordSecurityEvent } from "../lib/metrics"` and push CSRF / rate-limit / failed-login events with a locked signature; my events show up live in the admin feed.

## 4. Requirements (testable)

- [x] **REQ-158**: `GET /api/v1/admin/metrics` returns `AdminMetricsSnapshot` with `onlineUsers`, `messagesPerMinute`, `messagesPerMinuteSeries` (12 × 5s), `errorCount5min`, and `recentSecurityEvents`. Non-admin callers get 403; unauthenticated callers get 401. Multi-tab counts as one online user. IPs in security events are SHA-256(ip+SESSION_SECRET).slice(0,8), never raw.

## 5. Design notes

- **Data model**: no DB changes. In-memory singletons in `apps/backend/src/lib/metrics.ts`.
- **Backend routes**: `GET /api/v1/admin/metrics` (new). `onResponse` hook in `app.ts` feeds `recordHttpError` on every `reply.statusCode >= 500`.
- **Socket.IO tap**: `socket-handlers.ts` calls `recordUserConnect(userId)` / `recordUserDisconnect(userId)` alongside the presence broadcast. Multi-tab = refcount.
- **Messages tap**: `routes/messages.ts` gains one line (`recordMessageSent()`) inside the `!deduped` branch so dedup retries don't double-count.
- **Env**: `ADMIN_USER_IDS` CSV in `env.ts`, default empty. Read from `process.env` at REQUEST TIME so operators can rotate admins without a backend restart.
- **Frontend**: `apps/web/src/app/admin/page.tsx` polls `/api/v1/admin/metrics` every 2s. Plain HTML cards, CSS bars. Coexists with `apps/web/src/app/admin/federation/page.tsx` (S4, untouched).
- **Cross-agent contract**: `recordSecurityEvent({ type: "csrf_fail" | "rate_limited" | "login_failed", ip?, route? })` exported from `metrics.ts`. Locked signature — do not rename.

## 6. Tasks

1. [x] Shared type `AdminMetricsSnapshot` + `ADMIN_USER_IDS` env
2. [x] TDD ring-buffer unit tests → `metrics.ts` impl
3. [x] TDD online-user Socket.IO tap → wire `socket-handlers.ts`
4. [x] TDD `/admin/metrics` gate + shape → `routes/admin.ts` + `onResponse` 5xx hook
5. [x] One-line `recordMessageSent()` in `routes/messages.ts`
6. [x] `/admin/page.tsx` + `admin-api.ts` (poll + four widgets)
7. [x] `.env.example` documentation

## 7. Out of scope / follow-ups

- Horizontal scale (shared-metrics store) — park in `docs/FOLLOWUPS.md` if we ever ship > 1 backend process.
- Security-event persistence — the 50-deep ring is ephemeral by design.
- Proper RBAC — post-hackathon, admin-as-role instead of env CSV.

## 8. Open questions

None — brief §3 pre-resolved all of them.
