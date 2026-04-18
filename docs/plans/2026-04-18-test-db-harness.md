# Test DB Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Testcontainers-managed Postgres + Redis into `apps/backend` Vitest so integration tests run against hermetic, reused containers with TRUNCATE-based isolation.

**Architecture:** Vitest `globalSetup` starts `postgres:16-alpine` + `redis:7-alpine` with `.withReuse()`, applies Drizzle migrations via `drizzle-orm/node-postgres/migrator`, and provides connection URLs to tests via `inject()`. A shared `tests/db-helpers.ts` exposes `truncateAll()` (schema-derived, quoted identifiers) and `flushRedis()` invoked from `beforeEach`. Pool is singleton per fork; single-fork execution avoids cross-worker `TRUNCATE` contention.

**Tech Stack:** Vitest 2.x, `testcontainers` + `@testcontainers/postgresql` + `@testcontainers/redis`, `drizzle-orm/node-postgres/migrator`, `pg`.

**Reference:** [docs/adr/0005-test-db-harness.md](../adr/0005-test-db-harness.md). This plan implements that ADR verbatim.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `apps/backend/package.json` | Add testcontainers + postgres/redis modules to devDependencies |
| `apps/backend/tests/global-setup.ts` | **New.** Container boot, migration apply, `provide()` URLs, `teardown()` pool close |
| `apps/backend/tests/db-helpers.ts` | **New.** `ALL_TABLES`, `truncateAll()`, `flushRedis()`, `getTestPool()` singleton |
| `apps/backend/tests/setup.ts` | **Modify.** Inject URLs into `process.env`, register `beforeEach` + `afterAll` |
| `apps/backend/vitest.config.ts` | **Modify.** Add `globalSetup`, `pool: "forks"`, `singleFork: true` |
| `apps/backend/tests/harness-smoke.test.ts` | **New.** Smoke test asserting isolation works |
| `~/.testcontainers.properties` (dev machine) | **One-time.** Enable `testcontainers.reuse.enable=true` |

Each file has one responsibility. Tests do not reuse the app's `src/db.ts` pool — the test pool is built from the injected URL, decoupled from app config.

---

## Task 1: Install packages and enable reuse

**Files:**
- Modify: `apps/backend/package.json` (via pnpm)
- Create (one-time, user's home): `~/.testcontainers.properties`

- [ ] **Step 1.1: Install testcontainers + modules as devDependencies**

Run (from repo root):

```bash
pnpm --filter @ai-herders/backend add -D \
  testcontainers @testcontainers/postgresql @testcontainers/redis
```

Expected: `package.json` gains three entries under `devDependencies`. `pnpm-lock.yaml` updates.

- [ ] **Step 1.2: Verify the install resolved**

Run:

```bash
pnpm --filter @ai-herders/backend list testcontainers @testcontainers/postgresql @testcontainers/redis
```

Expected output: each package lists a version, no "missing peer" warnings.

- [ ] **Step 1.3: Enable container reuse (one-time per dev machine)**

Run:

```bash
grep -q 'testcontainers.reuse.enable' ~/.testcontainers.properties 2>/dev/null \
  || echo 'testcontainers.reuse.enable=true' >> ~/.testcontainers.properties
```

Verify:

```bash
cat ~/.testcontainers.properties
```

Expected: file contains `testcontainers.reuse.enable=true`.

- [ ] **Step 1.4: Commit**

```bash
git add apps/backend/package.json pnpm-lock.yaml
git commit -m "chore(backend): add testcontainers deps for test DB harness"
```

---

## Task 2: Create `tests/db-helpers.ts` (schema-derived truncate + flushRedis + pool)

**Files:**
- Create: `apps/backend/tests/db-helpers.ts`

- [ ] **Step 2.1: Write the helpers**

Create `apps/backend/tests/db-helpers.ts`:

```ts
// Test-only DB + Redis helpers. Uses an independent pg.Pool keyed off
// process.env.DATABASE_URL (populated by tests/setup.ts from inject()).
// Kept separate from src/db.ts so tests don't depend on app-side init order.

import { drizzle } from "drizzle-orm/node-postgres";
import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { createClient, type RedisClientType } from "redis";
import {
  account,
  attachment,
  friendRequest,
  friendship,
  message,
  messageSeq,
  room,
  roomBan,
  roomInvite,
  roomMember,
  session,
  user,
  userBlock,
  verification,
} from "@ai-herders/shared/schema";

// Explicit list keeps TS honest: adding a table in schema.ts without adding it
// here is caught by the smoke test (state leaks across tests for that table).
// getTableName() derives the SQL name from Drizzle metadata — no manual strings.
export const ALL_TABLES: PgTable[] = [
  account,
  attachment,
  friendRequest,
  friendship,
  message,
  messageSeq,
  room,
  roomBan,
  roomInvite,
  roomMember,
  session,
  user,
  userBlock,
  verification,
];

let pool: Pool | undefined;
let redis: RedisClientType | undefined;

export function getTestPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set — tests/setup.ts must inject it first");
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

export function getTestDb() {
  return drizzle(getTestPool());
}

async function getRedis(): Promise<RedisClientType> {
  if (!redis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL not set — tests/setup.ts must inject it first");
    redis = createClient({ url });
    await redis.connect();
  }
  return redis;
}

export async function truncateAll(): Promise<void> {
  const names = ALL_TABLES.map((t) => `"${getTableName(t)}"`).join(", ");
  await getTestPool().query(
    `TRUNCATE ${names} RESTART IDENTITY CASCADE`,
  );
}

export async function flushRedis(): Promise<void> {
  const client = await getRedis();
  await client.flushDb();
}

export async function closeTestConnections(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = undefined;
  }
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
```

- [ ] **Step 2.2: Typecheck the helper file in isolation**

Run:

```bash
pnpm --filter @ai-herders/backend typecheck
```

Expected: PASS. If it fails on `@ai-herders/shared/schema` import, confirm [packages/shared/src/schema.ts](../../packages/shared/src/schema.ts) exports every name imported above. If it fails on `redis` types, confirm `redis` is already in dependencies ([package.json:27](../../apps/backend/package.json#L27) — it is).

- [ ] **Step 2.3: Commit**

```bash
git add apps/backend/tests/db-helpers.ts
git commit -m "feat(backend-tests): add schema-derived truncateAll and flushRedis"
```

---

## Task 3: Create `tests/global-setup.ts`

**Files:**
- Create: `apps/backend/tests/global-setup.ts`

- [ ] **Step 3.1: Write the globalSetup**

Create `apps/backend/tests/global-setup.ts`:

```ts
// Vitest globalSetup — runs once per `vitest` invocation in the main process.
// Starts containers with .withReuse() so subsequent runs attach in <1s.
// Applies Drizzle migrations idempotently (__drizzle_migrations tracking).
// See docs/adr/0005-test-db-harness.md.

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Image tags MUST match docker-compose.yml so Docker's cache is reused.
const POSTGRES_IMAGE = "postgres:16-alpine";
const REDIS_IMAGE = "redis:7-alpine";

// Resolved from apps/backend/tests/global-setup.ts → repo root → infra/migrations.
// Three ups: tests → backend → apps → <root>. Do NOT change without retesting.
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../infra/migrations");

let migratePool: Pool | undefined;

export async function setup({
  provide,
}: {
  provide: (key: string, value: string) => void;
}): Promise<void> {
  const pg = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withReuse()
    .withStartupTimeout(60_000)
    .start();

  const redis = await new RedisContainer(REDIS_IMAGE)
    .withReuse()
    .withStartupTimeout(60_000)
    .start();

  const postgresUrl = pg.getConnectionUri();
  const redisUrl = redis.getConnectionUrl();

  migratePool = new Pool({ connectionString: postgresUrl });
  await migrate(drizzle(migratePool), { migrationsFolder: MIGRATIONS_DIR });

  provide("postgresUrl", postgresUrl);
  provide("redisUrl", redisUrl);
}

export async function teardown(): Promise<void> {
  // Pool close — without this Vitest hangs on exit.
  // Containers stay up thanks to .withReuse(); reattached next run.
  await migratePool?.end();
  migratePool = undefined;
}
```

- [ ] **Step 3.2: Declare the `inject()` types**

Append to `apps/backend/tests/global-setup.ts` (or add a separate `tests/vitest.d.ts` — inline keeps it one file):

```ts
declare module "vitest" {
  export interface ProvidedContext {
    postgresUrl: string;
    redisUrl: string;
  }
}
```

- [ ] **Step 3.3: Typecheck**

Run:

```bash
pnpm --filter @ai-herders/backend typecheck
```

Expected: PASS. Common failure: `drizzle-orm/node-postgres/migrator` not resolvable → confirm `drizzle-orm` is at least 0.29 (current version from [apps/backend/package.json:22](../../apps/backend/package.json#L22) is `^0.45.2` — fine).

- [ ] **Step 3.4: Commit**

```bash
git add apps/backend/tests/global-setup.ts
git commit -m "feat(backend-tests): add Testcontainers globalSetup with Drizzle migrator"
```

---

## Task 4: Wire `vitest.config.ts` (globalSetup + singleFork)

**Files:**
- Modify: `apps/backend/vitest.config.ts`

- [ ] **Step 4.1: Update the config**

Replace the entire contents of `apps/backend/vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    globals: false,
    setupFiles: ["tests/setup.ts"],
    globalSetup: ["tests/global-setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
});
```

- [ ] **Step 4.2: Commit**

```bash
git add apps/backend/vitest.config.ts
git commit -m "chore(backend-tests): wire globalSetup and singleFork pool"
```

---

## Task 5: Extend `tests/setup.ts` (inject URLs, register hooks)

**Files:**
- Modify: `apps/backend/tests/setup.ts`

- [ ] **Step 5.1: Replace contents**

Replace `apps/backend/tests/setup.ts` with:

```ts
// Runs before every test file in the backend fork.
// Injects container URLs from globalSetup BEFORE src/env.ts is imported by any
// test module; primes remaining env; registers isolation hooks.

import { afterAll, beforeEach, inject } from "vitest";
import { closeTestConnections, flushRedis, truncateAll } from "./db-helpers";

// MUST happen before any test-file import of src/db.ts or src/env.ts.
// inject() returns values provided by tests/global-setup.ts.
process.env.DATABASE_URL = inject("postgresUrl");
process.env.REDIS_URL = inject("redisUrl");

// Remaining env — priming only (existing tests depend on these defaults).
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "warn";
process.env.PORT ??= "4001";
process.env.WEB_ORIGIN ??= "http://localhost:3000";
process.env.SESSION_SECRET ??= "test-session-secret-32-chars-min!!";
process.env.UPLOAD_DIR ??= "./infra/uploads";

beforeEach(async () => {
  await truncateAll();
  await flushRedis();
});

afterAll(async () => {
  await closeTestConnections();
});
```

- [ ] **Step 5.2: Typecheck**

Run:

```bash
pnpm --filter @ai-herders/backend typecheck
```

Expected: PASS.

- [ ] **Step 5.3: Commit**

```bash
git add apps/backend/tests/setup.ts
git commit -m "feat(backend-tests): inject container URLs and wire isolation hooks"
```

---

## Task 6: Smoke test — verify isolation actually works

**Files:**
- Create: `apps/backend/tests/harness-smoke.test.ts`

- [ ] **Step 6.1: Write the smoke test**

Create `apps/backend/tests/harness-smoke.test.ts`:

```ts
// Verifies the Testcontainers harness end-to-end:
// 1. A test that inserts a row sees it.
// 2. The NEXT test sees zero rows (truncateAll ran between them).
// 3. Redis FLUSHDB similarly wipes between tests.
// If this passes, all four moving parts (containers, migrations,
// truncateAll, flushRedis) are wired correctly.

import { describe, expect, it } from "vitest";
import { createClient } from "redis";
import { user } from "@ai-herders/shared/schema";
import { getTestDb } from "./db-helpers";

describe("test DB harness", () => {
  it("inserts a user and reads it back", async () => {
    const db = getTestDb();
    await db.insert(user).values({
      id: "u-smoke-1",
      name: "Smoke A",
      email: "smoke-a@example.com",
      username: "smoke_a",
    });

    const rows = await db.select().from(user);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("u-smoke-1");
  });

  it("sees an empty users table — TRUNCATE ran between tests", async () => {
    const db = getTestDb();
    const rows = await db.select().from(user);
    expect(rows).toHaveLength(0);
  });

  it("reads and writes Redis, then sees it flushed next assertion", async () => {
    const client = createClient({ url: process.env.REDIS_URL });
    await client.connect();
    try {
      await client.set("smoke-key", "present");
      expect(await client.get("smoke-key")).toBe("present");
    } finally {
      await client.quit();
    }
  });

  it("Redis was flushed — previous test's key is gone", async () => {
    const client = createClient({ url: process.env.REDIS_URL });
    await client.connect();
    try {
      expect(await client.get("smoke-key")).toBeNull();
    } finally {
      await client.quit();
    }
  });
});
```

- [ ] **Step 6.2: Run just the smoke test and verify it passes**

Run:

```bash
pnpm --filter @ai-herders/backend test:run tests/harness-smoke.test.ts
```

Expected output: 4 tests pass. First run takes ~5–10s (container start + migration apply). Subsequent runs <2s (reattach).

If it fails with "DATABASE_URL not set" → `tests/setup.ts` isn't running before the test module. Confirm `setupFiles: ["tests/setup.ts"]` is in [vitest.config.ts:8](../../apps/backend/vitest.config.ts#L8).

If it fails with "relation \"user\" does not exist" → migrations didn't apply. Confirm `MIGRATIONS_DIR` in `global-setup.ts` resolves correctly by running:

```bash
node -e 'import("path").then(p => console.log(p.resolve("apps/backend/tests", "../../../infra/migrations")))'
```

Expected: absolute path ending in `infra/migrations`.

If it fails with "timeout of 15000ms exceeded" on first run → image pull is slow. Pre-pull:

```bash
docker pull postgres:16-alpine && docker pull redis:7-alpine
```

Then rerun.

- [ ] **Step 6.3: Commit**

```bash
git add apps/backend/tests/harness-smoke.test.ts
git commit -m "test(backend): smoke test for Testcontainers harness isolation"
```

---

## Task 7: Regression check — existing backend tests still pass

**Files:** none modified. This is verification only.

- [ ] **Step 7.1: Run the full backend test suite**

Run:

```bash
pnpm --filter @ai-herders/backend test:run
```

Expected: all existing tests (`auth-bridge`, `auth-validation`, `health`, `register-validation`, `schemas`) pass alongside `harness-smoke`.

If a previously-passing test now fails because `truncateAll()` wiped data it seeded inline → that test was relying on cross-test state (a latent bug). Fix by moving the seed into a `beforeEach` in that file.

If a test fails with "advisory lock" timeouts → the seq allocator is using `pg_advisory_lock` (session-scoped) instead of `pg_advisory_xact_lock`. See ADR §"Advisory-lock discipline". For now, add to the affected test's `afterEach`:

```ts
afterEach(async () => {
  await getTestPool().query("SELECT pg_advisory_unlock_all()");
});
```

and file a follow-up to migrate the allocator.

- [ ] **Step 7.2: Run twice in a row to confirm reuse is working**

Run:

```bash
time pnpm --filter @ai-herders/backend test:run
time pnpm --filter @ai-herders/backend test:run
```

Expected: second run's real-time is noticeably shorter (~1–2s of container startup removed). If both runs are equally slow, `testcontainers.reuse.enable=true` didn't take effect — recheck `~/.testcontainers.properties`.

- [ ] **Step 7.3: If any regression, fix, re-run, commit per affected test**

No commit if nothing regressed.

---

## Task 8: Document the escape hatch and dev setup

**Files:**
- Modify: `.human/` runbook or `README.md` — whichever the repo uses for dev setup

- [ ] **Step 8.1: Find the dev-setup doc**

Run:

```bash
ls /Users/littlewin/Work/2026-Apr-Hackaton/hackathon-starter/.human/ 2>/dev/null
cat /Users/littlewin/Work/2026-Apr-Hackaton/hackathon-starter/README.md 2>/dev/null | head -40
```

Pick whichever has dev-setup content. If neither, add to `README.md` under a "Testing" heading.

- [ ] **Step 8.2: Append dev-setup notes**

Add this section to the chosen file:

```markdown
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

**OrbStack/Colima users** need `DOCKER_HOST` set:
- OrbStack: `export DOCKER_HOST=unix:///$HOME/.orbstack/run/docker.sock`
- Colima: `export DOCKER_HOST=unix:///$HOME/.colima/default/docker.sock`
```

- [ ] **Step 8.3: Commit**

```bash
git add <path-modified>
git commit -m "docs: note Testcontainers setup + escape hatch for backend tests"
```

---

## Done Criteria

All of the following must be true:

- [ ] `pnpm --filter @ai-herders/backend test:run` exits 0 on a fresh clone after `pnpm install`.
- [ ] `harness-smoke.test.ts` passes all 4 tests.
- [ ] No existing backend tests regressed.
- [ ] Running the test suite twice in a row shows visible speedup on the second run (reuse confirmed).
- [ ] `nuke-and-retry` command is documented somewhere reachable from `README.md` or `.human/`.
- [ ] Docker containers `postgres:16-alpine` and `redis:7-alpine` labelled `org.testcontainers=true` are running after the first `test:run` and are NOT removed between runs.

---

## Known Non-Goals (explicitly deferred)

- DB-per-worker parallelism — `singleFork` suffices for current scope. Revisit if suite grows past ~50 tests.
- Advisory-lock migration — if the seq allocator uses `pg_advisory_lock`, wrap it in a follow-up to switch to `pg_advisory_xact_lock`. Not in this plan.
- `apps/web` testcontainers wiring — web tests are component-only. Out of scope.
- E2E (Playwright) changes — E2E continues to hit `docker compose`. Unchanged.
- CI workflow updates — harness works identically in CI without `.withReuse()` benefit; wire up when CI is added.
