# CLAUDE.md — Project memory for Claude Code

> This file is loaded into Claude's context every session. Keep it concise (<2000 tokens). Update it when Claude gets something wrong twice. For long-form content, link to `docs/` instead of inlining.

## Project

**Name:** AI Herders Jam — Online Chat Server
**Goal:** Ship a classic web chat server (accounts, rooms, DMs, files, moderation, 300 concurrent users) in 52h for a hackathon. Submission gate: public GitHub + `docker compose up` from repo root.
**Team:** 1 human (QA/automation background) + Claude Code Opus 4.7 (lead) + optional delegation to Gemini/Qwen/Cursor.
**Authoritative brief:** `/Users/littlewin/Work/2026-Apr-Hackaton/task/2026_04_18_AI_herders_jam_-_requirements_v3.docx`. The `/task/*.md` files are AI-generated prep, useful as REQ-ID hooks in test names but not binding.

## Non-negotiables

1. **Plan before code.** No implementation until a spec in `docs/specs/<feature>.md` is approved. Use the `/spec` command.
2. **TDD on core logic.** Write a failing test first for anything in `src/lib/` and `src/app/api/`. UI code can be test-after.
3. **Never commit secrets.** Read from `process.env.*`. Keys live in `.env.local` (gitignored).
4. **Keep PRs small.** One feature = one branch = one PR. Use `git worktree` for parallel streams.
5. **Ask before scope changes.** If you want to add a dependency, rename a public API, or change the data model — propose it, don't do it.
6. **Watermark discipline.** Every message broadcast carries `{seq, room_head_seq}`. Client gap-detects and backfills. No event bypasses the seq allocator. See `docs/adr/0003-watermark-protocol.md`.
7. **Bound all transient state.** No per-user durable queues. Socket.IO does transient fanout only; persistence is Postgres. Dormant users (1yr+ absence) must not grow state. See `memory: project-edge-cases`.

## Tech stack

- **Framework:** Next.js 15 App Router + TypeScript (strict) + React 19
- **Monorepo:** pnpm workspaces — `apps/web` (Next.js), `apps/backend` (Fastify), `packages/shared` (zod DTOs + Drizzle schema + Socket.IO protocol)
- **Styling:** Tailwind CSS + shadcn/ui
- **DB:** Postgres 16 + **Drizzle ORM** — schema is single source of truth in `packages/shared/src/schema.ts`. Migrations in `infra/migrations/*.sql`.
- **Auth:** **better-auth** — sessions list (v3.docx §2.2.4), keep-me-signed-in, built-in rate limiting, password reset/change. Never invent imports — verify via Context7 MCP.
- **Realtime:** **Socket.IO** (+ Redis adapter). Per-room monotonic `seq` watermark on every event; client gap-detects and backfills via history API.
- **Backend sidecar:** Fastify — atomic `seq` INSERT, rate limits (@fastify/rate-limit), local-FS file upload/download (v3.docx §3.4), moderation audit log.
- **Cache / pubsub:** Redis — Socket.IO adapter, rate-limit counters.
- **Testing:** Vitest (unit) + Supertest (backend) + Playwright (e2e) + k6 (load)
- **Deploy:** Docker only (`docker compose up` is the submission gate). No Vercel.

## Repo layout

```text
apps/
  web/              # Next.js App Router frontend
    src/app/        # Pages & route handlers
    src/components/ # React components; ui/ for shadcn primitives
    src/lib/        # Client-side business logic (TDD this)
  backend/          # Fastify sidecar
    src/server.ts   # Entry
    src/routes/     # /api/v1/* mutations, file upload/download
    src/socket.ts   # Socket.IO server + Redis adapter
packages/
  shared/           # Used by web + backend
    src/schema.ts   # Drizzle schema (tables + relations)
    src/dto.ts      # zod request/response schemas
    src/protocol.ts # Socket.IO event types + watermark contract
infra/
  migrations/       # SQL migrations (Drizzle-generated + hand-edited triggers)
  uploads/          # Local-FS attachment volume (gitignored content)
docs/
  specs/            # Feature specs — one .md per feature
  adr/              # Architecture decisions (0001-stack-pivot, 0002-no-xmpp, 0003-watermark-protocol)
  BRIEF.md          # v4-digest scope doc
  FEDERATION.md     # S4 XMPP façade documentation
tests/
  rls/              # Access-control tests (SQL-level)
  e2e/              # Playwright specs — test names contain REQ-IDs for traceability
  load/             # k6 scripts
.claude/            # Claude Code wiring (agents, commands, skills, hooks)
.human/             # Human-only runbook — PITCH.md etc.
```

## Commands you should know

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run web + backend concurrently (Next.js :3000, Fastify :4000) |
| `pnpm --filter web dev` | Next.js only |
| `pnpm --filter backend dev` | Fastify only |
| `pnpm db:generate` | `drizzle-kit generate` — regenerate migrations from schema |
| `pnpm db:migrate` | `drizzle-kit migrate` — apply migrations |
| `pnpm db:studio` | Drizzle Studio (DB browser) |
| `pnpm test` | Vitest in watch |
| `pnpm test:run` | Vitest one-shot (use in CI/hooks) |
| `pnpm test:e2e` | Playwright headless |
| `pnpm trace` | Greps `tests/` for REQ-IDs; fails if any MUST REQ lacks a test |
| `pnpm typecheck` | `tsc --noEmit` across all workspaces |
| `pnpm lint` | ESLint |
| `pnpm build` | Production build — must pass before merge |
| `docker compose up` | THE submission gate. Must work on a fresh clone. |

## Workflow (follow this)

1. **Spec** — `/spec <feature>` writes `docs/specs/<feature>.md`. I review and approve.
2. **Plan** — enter plan mode (`shift+tab` twice). Claude drafts the implementation plan. I approve.
3. **TDD** — for `src/lib/` and APIs: write failing test, implement, green, refactor. Commit at each stage.
4. **Implement** — small steps. Run `pnpm typecheck && pnpm test:run` before saying "done".
5. **Review** — delegate to the `code-reviewer` subagent for a fresh-context read-through.
6. **Ship** — `/ship` runs the pre-deploy checklist and opens a PR.

## Failure modes to actively avoid

These are Claude's known failure patterns. If you (Claude, reading this) notice yourself doing any of them, STOP and ask.

1. **Fabricating APIs.** Never reference a library method, import, or prop without confirming it exists. If unsure, read the source in `node_modules/` or ask the user for the doc URL.
2. **Loosening tests to make them pass.** The test is the spec. If a test fails, fix the CODE, not the test. If the test is genuinely wrong, stop and flag it — the human decides.
3. **Silent scope creep.** Change only what the current task requires. See something worth fixing? Add a `// TODO(hackathon):` and move on.
4. **Claiming "it works" without verifying.** Always run `pnpm typecheck` and `pnpm test:run` before saying a change is done. For UI, describe what you see at the relevant URL.
5. **Destructive git commands.** Never `git reset --hard`, `git checkout -- .`, `git clean -fd`, or `git branch -D` without explicit user approval. The settings.json deny list also blocks these.
6. **Runaway loops.** If the same approach has failed twice, stop and explain. Do not try it a third time with minor tweaks.

## Things Claude has gotten wrong on THIS project

> Add to this list as issues occur. This is how CLAUDE.md earns its keep.

- (nothing yet — first session)

## What to NOT do

- Don't auto-format via hook (wastes tokens via system reminders). Prettier runs on save + in CI.
- Don't create a custom subagent for every little task. Default to the built-in `Task` tool with the general-purpose subagent. Custom agents in `.claude/agents/` are only for recurring, well-scoped roles.
- Don't add MCP servers unless the benefit is obvious — each one burns context.
- Don't skip the spec. Even for "small" features. The 10 minutes of spec saves an hour of rework.

## How to reach the human

- I'm running QA at this hackathon. If you're stuck or unsure, **stop and ask** — don't guess. Cheap questions beat expensive rewrites.

## Recovery prompts

If I (the human) paste a prompt from `.claude/prompts/*.md`, follow it exactly — those are pre-written correction prompts for specific failure modes.
