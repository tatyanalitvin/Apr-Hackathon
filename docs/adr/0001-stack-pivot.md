# ADR-0001 — Stack pivot from Prisma/NextAuth/ad-hoc to Drizzle/better-auth/Socket.IO/Fastify

**Status**: accepted
**Date**: 2026-04-18 (H+0.5)
**Deciders**: Tatianka, Claude Opus 4.7

## Context

The Anthropic hackathon starter ships Next.js + Prisma + NextAuth + ad-hoc chat. We have 52 hours and must pass the `docker compose up` submission gate with accounts, rooms, DMs, files, moderation, 300 concurrent users, and a watermark protocol that survives gaps.

Three risks with the starter stack:

1. **NextAuth on App Router** requires hand-rolling the sessions-list UI that v3.docx §2.2.4 mandates; cost: ~4h for questionable correctness.
2. **Prisma in a monorepo with a Fastify sidecar** doubles tooling surface (two clients, two migration paths) and Prisma's connection pooler misbehaves under the concurrency we need.
3. **Ad-hoc realtime** means reinventing Redis fanout + gap-detection from scratch.

## Decision

Pivot to:

- **Drizzle ORM** — single schema in `packages/shared/src/schema.ts` consumed by both web and backend.
- **better-auth 1.6.5** — ships sessions list, rate limiting, password reset, scrypt hashing.
- **Socket.IO** (+ Redis adapter) — transient fanout with built-in reconnection hooks. Persistence stays in Postgres.
- **Fastify** sidecar on :4000 — houses the atomic seq allocator, file upload/download, and better-auth's HTTP handler. Next.js on :3000 stays UI-only.

## Consequences

+ Auth, rate limits, and session revocation are ~30 LoC of config instead of ~800 LoC of our own code.
+ Schema-first Drizzle means `pnpm db:generate` is the single migration authority.
+ Socket.IO Redis adapter gives horizontal scale for free (unused at 300 users, free insurance).
− Two processes to orchestrate in Docker. Mitigated by compose healthchecks.
− Learning curve for anyone who hasn't used better-auth; mitigated by Context7 MCP lookups before touching imports.

## Superseded docs

- `docs/specs/auth.md` (pre-pivot, Prisma + argon2 + homemade sessions) — deleted in commit `5753002`.
- `docs/BRIEF.md:21` "bcrypt cost-12" — corrected to scrypt (better-auth built-in) in the same commit as this ADR.
