# AI Herders Jam — Online Chat Server

> A self-hosted classic web chat server that runs with one command: `docker compose up`.

## What it is

Hackathon submission for **AI Herders Jam** (2026-04-18): accounts, public/private rooms, DMs, contacts, file sharing, moderation and persistent history, designed for up to 300 concurrent users. Built in 52 hours by one QA engineer + Claude Code Opus 4.7, spec-first and test-driven, following the v3.docx organizer brief. Full scope and stage plan in [docs/BRIEF.md](docs/BRIEF.md).

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
|---|---|---|
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
