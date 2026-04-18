# ADR 0005 — Test DB harness: Testcontainers with container reuse

**Status:** Accepted
**Date:** 2026-04-18
**Scope:** `apps/backend` Vitest integration tests only. `apps/web` (component tests) and `tests/e2e` (Playwright against compose) are explicitly out of scope.

## Context

Backend tests need a real Postgres 16 instance:

- REQ-032 seq allocator uses Postgres advisory locks (cannot use pg-mem).
- better-auth owns its own session tables and opens multiple pooled connections.
- Room-membership and ban access-control tests need real SQL semantics (uniqueness, FK cascades).

Redis is also required in-harness: Socket.IO adapter, better-auth rate-limit counters, unread pub/sub.

Two candidates were weighed:

### (a) Testcontainers-node with `.withReuse()`

Ephemeral `postgres:16-alpine` + `redis:7-alpine` containers spawned from Vitest `globalSetup`. Container reuse attaches subsequent runs to the same running container in <1s.

### (b) Reuse the `docker compose up` dev stack

Point tests at the already-running dev Postgres/Redis via a separate `hackathon_test` database, TRUNCATE between tests.

## Decision

**Adopt (a): Testcontainers-node with `.withReuse()`**, scoped to `apps/backend` only.

## Reasoning

The con list for (b) is larger than it looks:

1. **Schema-isolation friction.** Drizzle migrations target `public`; a second `hackathon_test` DB on the same cluster means a bootstrap path that runs migrations twice and stays in sync with the dev DB.
2. **Advisory-lock collision.** REQ-032 seq allocation uses advisory locks on the same Postgres instance the dev app is hitting. Two Vitest workers + a running dev app = non-deterministic failures on the watermark tests — the worst possible bug in a 52h window.
3. **Dev-data risk.** Seed data (`alice`, `bob`, `carol` + `general` room) lives in the dev DB. A misrouted `TRUNCATE` or a wrong `DATABASE_URL` wipes it at 2am.
4. **CI divergence.** GitHub Actions doesn't have our compose stack. (b) forces either a Postgres service container or installing testcontainers anyway — now we own two test harnesses.

Pros of (a) that aren't obvious from a naive read:

- **No image pull.** Dev compose already pulls `postgres:16-alpine` + `redis:7-alpine`. Testcontainers pins the identical tags and reuses Docker's image cache.
- **`.withReuse()` neutralises the "3–5s startup" con.** First run after boot pays ~3s; subsequent `vitest` reattaches in <1s.
- **Hermetic.** No possibility of clobbering dev data or colliding with the running app.
- **Same harness locally and in CI.** One setup path, one failure mode to debug.

Pros of (b) amount to "we don't install two packages," which is not a meaningful hackathon saving.

pg-mem and similar JS-only Postgres emulators were rejected: Drizzle migrations and advisory locks aren't reliably supported.

## Architecture

### Scope

- `apps/backend`: full Testcontainers harness (Postgres + Redis).
- `apps/web`: component/client tests only — **no** Testcontainers dependency.
- `tests/e2e` (Playwright): hits the real `docker compose` stack. Unaffected.

### Lifecycle — Vitest `globalSetup`

`apps/backend/tests/global-setup.ts` exports `setup({ provide })` and `teardown()`:

1. **Start containers** with `.withReuse()` and **`.withStartupTimeout(60_000)`** — image tags **must** match [docker-compose.yml](../../docker-compose.yml) (`postgres:16-alpine`, `redis:7-alpine`) or Testcontainers pulls a second multi-hundred-MB image and the "reuses Docker's image cache" claim is false. The explicit startup timeout matters on a cold machine: first pull of `postgres:16-alpine` can take 20–60s, and `globalSetup` does **not** honour Vitest's `hookTimeout`.
2. **Apply Drizzle migrations** programmatically via `drizzle-orm/node-postgres/migrator`:

   ```ts
   import { drizzle } from "drizzle-orm/node-postgres";
   import { migrate } from "drizzle-orm/node-postgres/migrator";

   const pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
   await migrate(drizzle(pool), {
     // resolved from apps/backend/tests/global-setup.ts
     migrationsFolder: path.resolve(__dirname, "../../../infra/migrations"),
   });
   ```

   This uses the `__drizzle_migrations` tracking table and is idempotent — **required** for `.withReuse()` safety. A reused container retains schema from prior runs; raw `pg` re-execution of `infra/migrations/*.sql` would fail on "already exists" or, worse, partially apply new migrations in an inconsistent state. The relative path is fragile; keep the literal above.
3. `provide("postgresUrl", ...)` and `provide("redisUrl", ...)` for tests via `inject()`.
4. **Teardown** closes the migration `pg.Pool` with `pool.end()`. Without this, Vitest hangs on exit instead of returning cleanly; containers themselves stay up thanks to `.withReuse()`.

Why the programmatic migrator instead of `drizzle-kit migrate` (which is already wired as `pnpm db:migrate`): the CLI spawn costs ~1–2s of Node/TS start per test run; the in-process migrator uses the same tracking table with no process-boot overhead.

### Advisory-lock discipline (REQ-032 seq allocator)

The seq allocator is *the* reason this harness exists. Two mutually exclusive patterns:

- **`pg_advisory_xact_lock(...)` — preferred.** Transaction-scoped; auto-released on COMMIT/ROLLBACK. Safe under connection pooling, TRUNCATE-between-tests, and Socket.IO fanout. **This is the pattern the seq allocator uses.**
- `pg_advisory_lock(...)` — session-scoped. The lock survives `TRUNCATE` and lingers on a pooled connection after the test ends, causing the next test to block or deadlock. If any code path slips to this variant, add `await db.execute(sql`SELECT pg_advisory_unlock_all()`)` to the `afterEach` chain as a safety net.

This is the exact class of bug Testcontainers was adopted to prevent — catching it here so it doesn't silently regress.

### Per-test isolation — TRUNCATE, not transaction rollback

Rationale: better-auth opens its own pooled connections for session writes; savepoint/rollback patterns break the moment a second connection touches data. TRUNCATE on empty tables is a few ms — simpler, bulletproof.

**Implementation:** `truncateAll()` in `apps/backend/tests/db-helpers.ts` derives the table list from the Drizzle schema in `packages/shared/src/schema.ts` — the schema is the single source of truth. Verified: the four better-auth tables (`user`, `session`, `account`, `verification`) are all defined in the shared schema file, so schema-driven enumeration covers them; better-auth does not manage a separate schema here. A hand-maintained table list would silently drift on every migration (e.g. adding `room_invite` in 0000 already produced this failure mode). The helper emits a single statement of the form:

```sql
TRUNCATE "table_a", "table_b", ... RESTART IDENTITY CASCADE;
```

Two details that **must** be in the helper:

- **Every identifier is quoted.** `user`, `session`, and others are Postgres reserved words; `TRUNCATE user` parses as `CURRENT_USER` and fails at runtime. The migration file already quotes every identifier — the helper does the same.
- **Tables without inbound foreign keys are enumerated explicitly.** `verification` (better-auth email/reset tokens) has no FK to `user`, so a `CASCADE` from truncating `user` does **not** clean it. State leaks into the next test. Schema-driven enumeration covers this automatically; a hand-written list does not.

### Parallelism — single fork

```ts
// vitest.config.ts
test: {
  pool: "forks",
  poolOptions: { forks: { singleFork: true } },
  globalSetup: "./tests/global-setup.ts",
}
```

Shared DB + parallel workers = flakes. Serial execution on an empty-table schema is plenty fast for this scope. If a specific suite needs parallelism later, switch to DB-per-worker via `CREATE DATABASE test_${workerId}` — deferred until measured need. Note for that future switch: `TRUNCATE` takes an `ACCESS EXCLUSIVE` lock; benign under `singleFork`, but if two workers share a database and truncate concurrently they will serialise and flake. DB-per-worker sidesteps this by giving each worker its own namespace.

### Redis reset

`FLUSHDB` against the test-provided Redis URL in the same `beforeEach`. Exposed as `flushRedis()` in `db-helpers.ts`.

### Operational constraints

- **One watcher at a time.** Two `pnpm test` watch sessions attach to the same reused container and stomp each other's `TRUNCATE` / `FLUSHDB` calls. Use `pnpm test:run` for ad-hoc runs while a watcher is active, or accept that only one watch session is supported per machine.
- **CI doesn't benefit from `.withReuse()`.** Fresh GitHub Actions runners have no prior container to attach to; every job pays the full cold-start cost (~3s container boot + ~5–15s image pull on cold runners + ~200ms migrations). Acceptable; documented so nobody is surprised.
- **Docker socket discovery on macOS.** Testcontainers auto-detects Docker Desktop. OrbStack and Colima users need `DOCKER_HOST` set (Orb: `unix:///$HOME/.orbstack/run/docker.sock`; Colima: `unix:///$HOME/.colima/default/docker.sock`). Add to the dev setup notes in `.human/`.
- **Nuke-and-retry escape hatch.** When a reused container ends up in a bad state (botched migration mid-write, manual `psql` poke, schema corruption), removing all Testcontainers-managed containers forces a clean restart on the next run:

  ```bash
  docker ps -aq --filter label=org.testcontainers=true | xargs -r docker rm -f
  ```

  Two lines now beats a 2am Slack thread.

## Implementation checklist

```bash
pnpm --filter @ai-herders/backend add -D \
  testcontainers @testcontainers/postgresql @testcontainers/redis
```

One-time per dev machine:

```bash
echo 'testcontainers.reuse.enable=true' >> ~/.testcontainers.properties
```

Files to create or modify:

- `apps/backend/tests/global-setup.ts` — container boot (matching `-alpine` tags) + `drizzle-orm/node-postgres/migrator` application + `provide()` URLs
- `apps/backend/tests/db-helpers.ts` — `getDb()`, `truncateAll()` (schema-derived, quoted identifiers), `flushRedis()`
- `apps/backend/tests/setup.ts` — existing per-file setup; call `truncateAll()` + `flushRedis()` in `beforeEach`
- `apps/backend/vitest.config.ts` — add `globalSetup` + `singleFork` pool

## Consequences

**Positive:**

- Tests are hermetic; dev data is untouchable from the test suite.
- Identical harness locally and in CI.
- Advisory-lock tests (seq watermark) are deterministic.
- First-run overhead (~3s) only; reuse amortises it across the hackathon.

**Negative:**

- Docker daemon must be running to execute backend tests. Mitigation: already true for compose.
- ~200ms migration apply cost on first container boot per day. Negligible.
- Only one `pnpm test` watcher at a time per machine (see Operational constraints).

**Revisit if:**

- Backend suite grows past ~50 tests and serial execution becomes the long pole — switch to DB-per-worker.
- We end up needing parallel suites before H+38 — same switch.
