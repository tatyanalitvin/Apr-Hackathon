// Runs before every test file in the backend fork.
// Injects container URLs from globalSetup BEFORE src/env.ts is imported by any
// test module; primes remaining env; registers isolation hooks.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, inject } from "vitest";
import { flushRedis, getTestPool, truncateAll } from "./db-helpers";

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
// Per-process UPLOAD_DIR under the OS tmpdir so attachment uploads can't
// pollute the working tree (the dev default ./infra/uploads is a real path
// inside the repo and would show up in `git status` after a test run).
// Always overwrite — tests should never share UPLOAD_DIR with the dev server.
process.env.UPLOAD_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "ai-herders-uploads-"),
);

// `pg_advisory_unlock_all()` before TRUNCATE: insurance against a session-scoped
// advisory lock leaking from a previous test (docs/adr/0005-test-db-harness.md
// §"Advisory-lock discipline"). Without this, a stray lock can make the next
// TRUNCATE block and the suite hang at 15s hookTimeout.
//
// Pool/Redis teardown is deliberately NOT registered here: `setupFiles` modules
// re-register top-level hooks per test file, so an `afterAll` here would thrash
// the singletons between files. With `singleFork: true`, the fork exits cleanly
// and the OS reaps sockets; `.withReuse()` keeps the containers alive.
beforeEach(async () => {
  await getTestPool().query("SELECT pg_advisory_unlock_all()");
  await truncateAll();
  await flushRedis();
});
