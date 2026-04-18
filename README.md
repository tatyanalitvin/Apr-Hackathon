# Hackathon Starter — Claude Code edition

A production-grade scaffold for building a non-trivial web app at a hackathon with Claude Code as your co-engineer.

**Stack**: Next.js 15 · TypeScript (strict) · Tailwind · shadcn/ui · Anthropic SDK · Vitest · Playwright.

**What's pre-wired for Claude Code**:
- `CLAUDE.md` — project memory that loads into every session
- `.claude/agents/` — four focused subagents: `spec-writer`, `test-writer`, `code-reviewer`, `ui-designer`
- `.claude/commands/` — slash commands: `/spec`, `/tdd`, `/review`, `/ship`, `/catchup`
- `.claude/skills/` — skill packs: shadcn-ui, playwright-e2e, anthropic-sdk, ui-design
- `.claude/hooks/` — typecheck after every edit; reminder on session stop
- `.claude/settings.json` — permission allowlist + hook registration
- `docs/PLAYBOOK.md` — hour-by-hour hackathon runbook
- `docs/specs/_TEMPLATE.md` — spec template for feature-driven development

## Quick start

```bash
pnpm install
cp .env.example .env.local          # paste your ANTHROPIC_API_KEY
pnpm dev                             # http://localhost:3000
```

In another terminal, start Claude Code:

```bash
npm i -g @anthropic-ai/claude-code
claude
```

Inside Claude Code:

```
/catchup                             # hydrate context
/spec my-feature "one-line idea"     # start a new feature with a spec
/tdd my-feature                      # implement the approved spec test-first
/review                              # fresh-context code review
/ship                                # pre-deploy checklist
```

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Next.js dev server (Turbopack) |
| `pnpm build` | Production build |
| `pnpm start` | Run the built app |
| `pnpm test` | Vitest watch mode |
| `pnpm test:run` | Vitest one-shot |
| `pnpm test:e2e` | Playwright headless |
| `pnpm test:e2e:ui` | Playwright interactive |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm format` | Prettier write |

## Testing

### Backend test DB harness

Backend tests use Testcontainers-managed Postgres + Redis (see [ADR 0005](docs/adr/0005-test-db-harness.md)). One-time setup per machine:

```bash
echo 'testcontainers.reuse.enable=true' >> ~/.testcontainers.properties
```

Run tests:

```bash
pnpm --filter @ai-herders/backend test:run      # one-shot
pnpm --filter @ai-herders/backend test          # watch (one watcher at a time)
```

**If tests hang or containers are in a bad state**, nuke and retry:

```bash
docker ps -aq --filter label=org.testcontainers=true | xargs -r docker rm -f
```

**OrbStack / Colima users** need `DOCKER_HOST` set:

- OrbStack: `export DOCKER_HOST=unix:///$HOME/.orbstack/run/docker.sock`
- Colima: `export DOCKER_HOST=unix:///$HOME/.colima/default/docker.sock`

## Philosophy

Based on Anthropic's own internal playbook + synthesized from ~15 public sources (2025-2026). Key principles:

1. **Plan before code** — every feature gets a spec in `docs/specs/`. Approved before implementation.
2. **TDD on core logic** — `src/lib/` and `src/app/api/` always.
3. **Small, frequent commits** — one requirement = one commit. Easy to revert.
4. **Subagents for isolation** — code review, test writing, and UI design run in fresh contexts so the main chat stays focused.
5. **Skills > MCP** — local procedural knowledge in `.claude/skills/` costs ~0 tokens until invoked. MCP servers eat context.
6. **Hooks are surface, not gate** — they warn, they don't block. Claude sees the warning, fixes itself.

Read `docs/PLAYBOOK.md` for the hour-by-hour hackathon runbook.

## Customizing for your project

On day 0, update:
1. `CLAUDE.md` — fill in the project name + goal + anything specific.
2. `docs/DESIGN.md` — pick one visual direction and commit.
3. `docs/ARCHITECTURE.md` — add/remove components as your system takes shape.
4. `package.json#name` + `.env.example#NEXT_PUBLIC_APP_NAME`.

## License

MIT — copy freely, make it yours.
