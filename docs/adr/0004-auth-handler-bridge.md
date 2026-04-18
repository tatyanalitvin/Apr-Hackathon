# ADR-0004 — Bridge better-auth's fetch handler into Fastify via a catch-all route

**Status**: accepted
**Date**: 2026-04-18 (H+3.5, task #1)
**Deciders**: Claude Opus 4.7 (confirmed with Tatianka before commit `5753002`)

## Context

better-auth ships a single `auth.handler: (Request) => Promise<Response>` in the web-standard Fetch API shape. Fastify is a Node-style framework; it doesn't consume a Fetch handler directly. Three mounting options were considered:

1. **`fastify-better-auth` plugin** — community plugin. At the time of writing (2026-04-18, better-auth 1.6.5) it lags behind the core release cadence; version pinning is brittle.
2. **Run better-auth on its own HTTP server** — split-brain CORS, two sets of logs, bonus network hop. Rejected.
3. **Catch-all Fastify route → Web Request → `auth.handler` → copy Response** — ~25 LoC, zero extra deps, survives better-auth upgrades.

## Decision

Implement option 3 in `apps/backend/src/app.ts`. The route matches all verbs on `/api/auth/*`, builds a `Request` from Fastify's `request.headers` + `request.body` (JSON-stringified because Fastify pre-parses JSON), awaits `auth.handler`, and copies status + headers + body text onto the Fastify reply.

## Consequences

+ No third-party plugin surface; upgrades are just `pnpm up better-auth`.
+ Every `/api/auth/*` endpoint better-auth adds in future versions works without code change.
+ Keeps better-auth on the same Fastify instance as `/health`, the seq allocator (S1), and file routes (S2) — one process, one CORS policy.
− Body handling is slightly awkward because Fastify pre-parses JSON; we re-stringify. For file uploads (`multipart/form-data`) this would need refinement — not in scope for auth (no file fields on sign-up/sign-in).
− Streamed responses come back as `.text()` (we await the full body before replying). For better-auth's payload sizes this is fine; if we ever use it for a streaming endpoint, revisit.

## References

- `apps/backend/src/app.ts` — the bridge.
- `apps/backend/tests/auth-bridge.test.ts` — 2 integration tests locking in the contract (`get-session` returns 200+null, `sign-in/email` is not 404).
- better-auth docs (Context7 `/llmstxt/better-auth_llms_txt`, fetched 2026-04-18).
