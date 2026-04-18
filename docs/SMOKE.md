# SMOKE.md — submission-gate verification

This doc is the judge-facing recipe for the v3.docx §7 submission gate: a
fresh clone plus `docker compose up` must produce a working auth + chat
backend. Copy-paste the whole block on a clean machine with Docker 24+ and
Docker Compose v2.

Scope verified here: Postgres + Redis + migrate + backend (Fastify). The
web container builds and serves `/` but the UI flow is not part of S1 — it
ships in the `feat/s1-web` branch. The steps below exercise the backend
REST surface directly with `curl`.

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
#    backend depends on `migrate` completing, so the first run adds ~3s for
#    drizzle-kit to apply `infra/migrations/*.sql`.
docker compose ps
# Expected: postgres (healthy), redis (healthy), backend (healthy), app (Up),
#           migrate (Exited 0).
```

If `docker compose ps` still shows `backend (starting)` after 30 seconds,
tail the backend logs — `docker compose logs -f backend` — and check that
migrate exited 0: `docker compose logs migrate`.

## 2 — Verify /health

```bash
curl -sf http://localhost:4000/health
# → {"status":"ok","service":"backend","env":"production"}
```

## 3 — Seed the demo fixture (REQ-049)

```bash
docker compose exec backend pnpm db:seed
# Expected output (first run):
#   [seed] done { createdUsers: 3, createdRoom: true, createdMembers: 3, createdMessages: 3 }
# Re-running is idempotent:
#   [seed] done { createdUsers: 0, createdRoom: false, createdMembers: 0, createdMessages: 0 }
```

**Known quirk (application-layer, not infra):** `scripts/seed.ts` commits
all data correctly but does not self-exit — it leaves a Redis client handle
open after the work is done. The process is safe to kill once you see
`[seed] done`; press `Ctrl-C`. See "Application-layer issues" below.

CI-friendly variant (no interactive Ctrl-C):

```bash
docker compose exec -d backend pnpm db:seed
# Wait for the completion log line, then stop the detached exec's process
# inside the container:
until docker compose exec -T backend grep -q "\[seed\] done" /proc/*/fd/1 2>/dev/null; do sleep 1; done
docker compose exec -T backend pkill -f "scripts/seed.ts" || true
```

(If that feels too surgical: the `[seed] done` line lands in the detached
exec's output, which `docker compose logs backend` does not capture. The
simplest path for judges is the foreground command with `Ctrl-C`.)

## 4 — Register a brand-new user

```bash
curl -s -X POST http://localhost:4000/api/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"smoke@herders.local","username":"smoke1","password":"hunter2hunter2","name":"Smoke Tester"}'
# → {"token":"…","user":{"name":"Smoke Tester","email":"smoke@herders.local",…,"username":"smoke1","id":"…"}}
```

The request payload must match `registerSchema` in
`packages/shared/src/dto.ts` (email / username / password ≥ 8 / name).

## 5 — Sign in as a seeded user (alice) and capture the session cookie

The smoke procedure's send-message step needs a session cookie for a user
who is already a member of `general`. In S1 there is no self-serve
"join-public-room" endpoint (see spec §R14 + "Application-layer issues"
below), so fresh signups cannot post to seeded rooms. We sign in as
`alice` (seeded via REQ-049) to exercise the message flow.

```bash
rm -f /tmp/cookies.txt

curl -s -c /tmp/cookies.txt -X POST http://localhost:4000/api/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@herders.local","password":"hunter2hunter2"}' >/dev/null

grep better-auth.session_token /tmp/cookies.txt
# → #HttpOnly_localhost  FALSE  /  FALSE  …  better-auth.session_token  <opaque>
```

## 6 — Send a message to `general`

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

## 7 — Fetch room history with watermark

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

## Application-layer issues (flagged, NOT fixed here)

These were observed while running the smoke. Per the infra-smoke charter,
they must be handled by the app agents on `feat/s1-chat` / `feat/s1-auth`,
not on `chore/infra-smoke`.

1. **`scripts/seed.ts` does not self-exit.** The seed calls
   `auth.api.signUpEmail`, which pulls in `better-auth`'s rate limiter and
   opens a Redis client via `apps/backend/src/secondary-storage.ts`. The
   script closes the pg pool at the end but never closes the Redis client,
   so the Node event loop stays alive. Data commits are correct and the
   script is idempotent — but a judge running the seed in foreground has to
   `Ctrl-C` after `[seed] done` appears. **Suggested fix:** export a
   `close()` from `secondary-storage.ts` and call it in `seed.ts` `main()`
   after `pool.end()`, or call `process.exit(0)` after the success log.

2. **Fresh signups cannot post to seeded rooms (no self-join endpoint).** A
   user registered via `/api/auth/sign-up/email` is not a member of any
   room until someone adds them. Posting to `general` as such a user
   returns `403 {"error":"forbidden"}` — exactly as specified by
   `apps/backend/src/lib/message-auth.ts:44-47` and
   `docs/specs/s1-chat.md` §R14. The room-join / room-catalog flow
   (REQ-021…REQ-028) is on the S1 docket but not wired to a REST endpoint
   yet. **Impact on the demo:** the pitch works because bob / carol are
   seeded into `general`; new walk-up accounts have no room they can
   actually post in. **Suggested fix on the app side:** either auto-enroll
   every new account into `general` on sign-up (one INSERT into
   `room_member`), or land the REQ-022 catalog + join endpoint.

Neither of these blocks `docker compose up --build` from producing a
working system. The submission gate is green.

## Infra changes made on `chore/infra-smoke`

For reviewer context, the diff on this branch against `main` consists of:

- **`docker-compose.yml`** — added a one-shot `migrate` service that runs
  `pnpm db:migrate` after Postgres is healthy and before backend starts.
  Backend now `depends_on.migrate: service_completed_successfully` so the
  app never serves traffic against an empty schema. Without this, a fresh
  `docker compose up` would bring the backend up with zero tables and the
  first auth request would ECONNRESET.

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
