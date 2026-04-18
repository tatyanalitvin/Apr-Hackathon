# SMOKE.md — submission-gate verification

This doc is the judge-facing recipe for the v3.docx §7 submission gate: a
fresh clone plus `docker compose up` must produce a working auth + chat
backend. Copy-paste the whole block on a clean machine with Docker 24+ and
Docker Compose v2.

Scope verified here: full S1 stack — Postgres + Redis + migrate + seed +
backend (Fastify) + web (Next.js). The steps below exercise the backend
REST surface directly with `curl`; `/login` and `/register` are
client-rendered, so a static HTML grep for "login" / "register" will miss —
open `http://localhost:3000/login` in a browser (or drive it with
Playwright) to confirm the form paints. A bare `HTTP 200` from
`curl -sfI http://localhost:3000/login` is the sanity check the compose
gate owes the judge; the interactive flow is out of scope for this doc.

## 0 — Prerequisites

- Docker Engine 24+ with Compose plugin (`docker compose version` prints v2.x
  or later).
- Host TCP ports `3000`, `4000`, `5432`, `6379` free.
- No host-side `.env` file is required: `docker-compose.yml` provides safe
  defaults for `SESSION_SECRET` and friends. Override via `.env` if you want
  to customize.

## 1 — Bring up the stack

```bash
# 1. Nuke any prior state (first run on a fresh clone is a no-op).
docker compose down -v

# 2. Build images and start detached. First run pulls base images + installs
#    deps; expect 2–4 minutes on a warm network, 30–60 seconds thereafter.
docker compose up --build -d

# 3. Wait for all services to report healthy. Postgres + Redis come up fast;
#    backend depends on `migrate` then `seed` completing, so the first run
#    adds ~3s for drizzle-kit + ~2s for the demo-fixture seed.
docker compose ps
# Expected: postgres (healthy), redis (healthy), backend (healthy), app (Up),
#           migrate (Exited 0), seed (Exited 0).
```

If `docker compose ps` still shows `backend (starting)` after 30 seconds,
tail the backend logs — `docker compose logs -f backend` — and check that
migrate + seed both exited 0: `docker compose logs migrate seed`.

## 2 — Verify /health

```bash
curl -sf http://localhost:4000/health
# → {"status":"ok","service":"backend","env":"production"}
```

The demo fixture (REQ-049: alice/bob/carol + `general` room + 3 seed
messages + memberships) is already in the DB — the `seed` one-shot service
ran as part of `docker compose up` and backend gates on its successful
exit. Re-running `docker compose up` is idempotent: `scripts/seed.ts` uses
`ON CONFLICT DO NOTHING` everywhere, so existing rows are left alone.

## 3 — Register a brand-new user

```bash
curl -s -X POST http://localhost:4000/api/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"smoke@herders.local","username":"smoke1","password":"hunter2hunter2","name":"Smoke Tester"}'
# → {"token":"…","user":{"name":"Smoke Tester","email":"smoke@herders.local",…,"username":"smoke1","id":"…"}}
```

The request payload must match `registerSchema` in
`packages/shared/src/dto.ts` (email / username / password ≥ 8 / name).

## 4 — Sign in as a seeded user (alice) and capture the session cookie

The smoke procedure's send-message step exercises the message flow as a
known-membership user. Fresh signups are also enrolled in `general`
automatically (see `apps/backend/src/auth.ts` `databaseHooks.user.create`),
but signing in as alice keeps this recipe deterministic across re-runs.

```bash
rm -f /tmp/cookies.txt

curl -s -c /tmp/cookies.txt -X POST http://localhost:4000/api/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@herders.local","password":"hunter2hunter2"}' >/dev/null

grep better-auth.session_token /tmp/cookies.txt
# → #HttpOnly_localhost  FALSE  /  FALSE  …  better-auth.session_token  <opaque>
```

## 5 — Send a message to `general`

```bash
curl -s -b /tmp/cookies.txt -X POST http://localhost:4000/api/v1/rooms/general/messages \
  -H 'Content-Type: application/json' \
  -d '{"body":"smoke-test hello from alice"}'
# → {"id":"…","roomId":"general","authorId":"…","body":"smoke-test hello from alice",
#    "seq":"4","replyToId":null,"editedAt":null,"createdAt":"…"}
```

`seq:"4"` on a fresh database: seed wrote three messages, this is the
fourth. Body shape matches `sendMessageSchema` in
`packages/shared/src/dto.ts`.

## 6 — Fetch room history with watermark

```bash
curl -s -b /tmp/cookies.txt http://localhost:4000/api/v1/rooms/general/messages | jq .
# → {
#      "roomId": "general",
#      "fromSeq": "1",
#      "toSeq": "4",
#      "roomHeadSeq": "4",
#      "messages": [ … 4 entries, ordered by seq ]
#    }
```

`roomHeadSeq` mirrors the watermark published on the Socket.IO `message.new`
event (ADR-0003) — clients gap-detect against this value.

## Previously-flagged application-layer issues (now resolved)

Earlier iterations of this doc flagged two issues the infra-smoke branch
could not fix. Both are now closed; recorded here for reviewer continuity.

1. **`scripts/seed.ts` did not self-exit.** The seed opened a Redis client
   via `apps/backend/src/secondary-storage.ts` (for better-auth's rate
   limiter) and never closed it, so the Node event loop stayed alive and
   judges had to `Ctrl-C` after `[seed] done`. Resolved by exporting
   `closeSecondaryStorage()` and calling it in `seed.ts` `main()` after
   `pool.end()`. Required to run `db:seed` as a compose one-shot gated by
   `service_completed_successfully`.

2. **Fresh signups could not post to seeded rooms.** A new user registered
   via `/api/auth/sign-up/email` had no `room_member` row, so posting to
   `general` returned `403 {"error":"forbidden"}`. Resolved by the
   `databaseHooks.user.create.after` hook in `apps/backend/src/auth.ts`
   which inserts a `room_member` row for `(newUser, 'general')`. Full
   REQ-022 (catalog + self-join UI) is still S2 scope.

## Infra changes summary

For reviewer context, the infra diff against `main` consists of:

- **`docker-compose.yml`** — one-shot `migrate` service (`pnpm db:migrate`)
  runs after Postgres is healthy. One-shot `seed` service (`pnpm db:seed`,
  REQ-049 demo fixture) runs after `migrate` exits 0 and before backend
  starts. Backend `depends_on.seed: service_completed_successfully` so the
  `'general'` room the auto-enroll hook expects is guaranteed present on
  every fresh `docker compose up`. Without `migrate` the first auth
  request would ECONNRESET against an empty schema; without `seed`, a
  fresh signup landing on `/rooms/general` would get 403 or a blank UI.

- **`apps/web/Dockerfile`** — collapsed the `deps` / `builder` split into a
  single `builder` stage that runs `pnpm install` in place. The previous
  two-stage layout copied `/app/node_modules` from `deps` into `builder`
  but did not copy the workspace-local `apps/web/node_modules`, which is
  where pnpm symlinks the `next` binary. The builder then ran
  `pnpm --filter @ai-herders/web build` and failed with `sh: next: not
  found`.

- **`docs/SMOKE.md`** — this file.

No application code, no shared package code, no spec files were touched on
this branch.
