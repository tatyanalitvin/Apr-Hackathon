// Primes process.env for tests before `src/env.ts` runs its zod validation.
// Integration tests that actually talk to Postgres/Redis will override these
// via per-test setup; for the rig smoke-test they just need to be non-empty.

process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "warn";
process.env.PORT ??= "4001";
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.WEB_ORIGIN ??= "http://localhost:3000";
process.env.SESSION_SECRET ??= "test-session-secret-32-chars-min!!";
process.env.UPLOAD_DIR ??= "./infra/uploads";
