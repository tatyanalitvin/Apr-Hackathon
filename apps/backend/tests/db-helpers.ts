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

// Refuse to truncate anything that doesn't look like a Testcontainers-managed
// Postgres. Testcontainers binds on a random high port; the dev compose stack
// uses 5432. This guard is the "2am DATABASE_URL mistake" insurance called out
// in docs/adr/0005-test-db-harness.md §Reasoning point 3.
function assertTestDatabaseUrl(url: string | undefined): asserts url is string {
  if (!url) throw new Error("truncateAll(): DATABASE_URL not set");
  const portMatch = url.match(/@[^/:]+:(\d+)\//);
  const port = portMatch ? Number(portMatch[1]) : NaN;
  if (!Number.isFinite(port) || port === 5432) {
    throw new Error(
      `truncateAll(): refusing to run against DATABASE_URL with port=${portMatch?.[1] ?? "unknown"}. ` +
        `Testcontainers binds a random high port; 5432 is the dev compose Postgres.`,
    );
  }
}

export async function truncateAll(): Promise<void> {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const names = ALL_TABLES.map((t) => `"${getTableName(t)}"`).join(", ");
  await getTestPool().query(
    `TRUNCATE ${names} RESTART IDENTITY CASCADE`,
  );
}

export async function flushRedis(): Promise<void> {
  const client = await getRedis();
  await client.flushDb();
}
