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
