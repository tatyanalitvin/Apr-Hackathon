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
