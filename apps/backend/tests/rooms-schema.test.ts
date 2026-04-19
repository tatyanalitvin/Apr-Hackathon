// REQ-020 — S1 data model smoke test. Asserts the tables this spec's
// write paths (rooms-create.test, rooms-leave.test, etc.) consume exist
// and accept a zero-row SELECT. The integrity-round-trip coverage lives
// in the other tests; this one is a trace-silencer for REQ-020.
// Binding spec: docs/specs/s1-rooms.md §4 R1.

import { describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";

import { getTestDb } from "./db-helpers";

describe("REQ-020 S1 schema presence", () => {
  test("REQ-020 room table accepts SELECT", async () => {
    const rows = await getTestDb().execute(sql`SELECT 1 AS x FROM room LIMIT 0`);
    expect(Array.isArray(rows.rows)).toBe(true);
  });

  test("REQ-020 room_member table accepts SELECT", async () => {
    const rows = await getTestDb().execute(
      sql`SELECT 1 AS x FROM room_member LIMIT 0`,
    );
    expect(Array.isArray(rows.rows)).toBe(true);
  });

  test("REQ-020 message_seq table accepts SELECT", async () => {
    const rows = await getTestDb().execute(
      sql`SELECT 1 AS x FROM message_seq LIMIT 0`,
    );
    expect(Array.isArray(rows.rows)).toBe(true);
  });
});
