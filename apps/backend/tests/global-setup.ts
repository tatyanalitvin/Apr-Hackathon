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

declare module "vitest" {
  export interface ProvidedContext {
    postgresUrl: string;
    redisUrl: string;
  }
}
