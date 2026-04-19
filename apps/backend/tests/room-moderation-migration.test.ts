// REQ-200 — 0007_room_roles.sql backfill migration.
// Binding spec: docs/specs/s2-moderation.md §4 REQ-200 + §6 Task 2.
//
// DDL (room_role enum, room_member.role column, room_ban table) already lives
// in 0000_chilly_whirlwind.sql. Migration 0007 is backfill-only:
//   UPDATE room_member SET role='owner'
//     WHERE (room_id, user_id) IN
//       (SELECT id, owner_id FROM room WHERE owner_id IS NOT NULL);
//
// Two invariants under test:
//   (a) First run flips each room's owner-membership row from 'member' to
//       'owner'; non-owner members + rows with NULL owner_id are untouched.
//   (b) Second run is a pure no-op (rowCount === 0) — required by §4 REQ-200
//       so re-migrations on already-backfilled DBs don't churn rows.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, test, beforeEach } from "vitest";
import { sql } from "drizzle-orm";

import { getTestDb, getTestPool } from "./db-helpers";

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../infra/migrations/0007_room_roles.sql",
);

function loadMigration(): string {
  return fs.readFileSync(MIGRATION_PATH, "utf8");
}

async function seedUser(username: string): Promise<string> {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO "user" (id, name, email, username, email_verified, created_at, updated_at)
    VALUES (${id}, ${username}, ${`${username}@test.local`}, ${username}, false, now(), now())
  `);
  return id;
}

async function seedRoom(name: string, ownerId: string | null): Promise<string> {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO room (id, name, kind, visibility, owner_id, created_at)
    VALUES (${id}, ${name}, 'group', 'public', ${ownerId}, now())
  `);
  return id;
}

async function seedMember(
  roomId: string,
  userId: string,
  role: "owner" | "admin" | "member",
): Promise<void> {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO room_member (id, user_id, room_id, role, joined_at, last_read_seq, muted)
    VALUES (${id}, ${userId}, ${roomId}, ${role}::room_role, now(), 0, false)
  `);
}

async function roleOf(
  roomId: string,
  userId: string,
): Promise<string | undefined> {
  const rows = (await getTestDb().execute(sql`
    SELECT role::text AS role FROM room_member
    WHERE room_id = ${roomId} AND user_id = ${userId}
  `)).rows as Array<{ role: string }>;
  return rows[0]?.role;
}

describe("REQ-200 0007 backfill migration", () => {
  // Extra safety — setup.ts TRUNCATE already runs, but declare intent.
  beforeEach(async () => {
    // no-op; left here as an anchor for future per-test state if needed.
  });

  test("REQ-200 flips legacy owner-membership row from 'member' to 'owner'", async () => {
    const aliceId = await seedUser(`alice-${randomUUID().slice(0, 8)}`);
    const roomId = await seedRoom("legacy-room", aliceId);
    // Simulate legacy state: the owner's room_member row has role='member'
    // (pre-c84948c rooms created before the rooms.ts create handler started
    // writing role='owner' by hand).
    await seedMember(roomId, aliceId, "member");

    await getTestPool().query(loadMigration());

    expect(await roleOf(roomId, aliceId)).toBe("owner");
  });

  test("REQ-200 leaves non-owner members alone", async () => {
    const aliceId = await seedUser(`alice-${randomUUID().slice(0, 8)}`);
    const bobId = await seedUser(`bob-${randomUUID().slice(0, 8)}`);
    const roomId = await seedRoom("mixed-room", aliceId);
    await seedMember(roomId, aliceId, "member"); // legacy owner
    await seedMember(roomId, bobId, "member"); // plain member, must stay

    await getTestPool().query(loadMigration());

    expect(await roleOf(roomId, aliceId)).toBe("owner");
    expect(await roleOf(roomId, bobId)).toBe("member");
  });

  test("REQ-200 does not touch rooms with NULL owner_id", async () => {
    // DM rooms have owner_id NULL + kind='dm'; group rooms CAN also land with
    // NULL owner_id after an owner's account is soft-deleted (schema.ts:118
    // ON DELETE SET NULL). The backfill's WHERE guard must exclude these —
    // otherwise an UPDATE...IN(NULL) no-op still risks a rowCount surprise.
    const carolId = await seedUser(`carol-${randomUUID().slice(0, 8)}`);
    const roomId = await seedRoom("orphan-room", null);
    await seedMember(roomId, carolId, "member");

    await getTestPool().query(loadMigration());

    expect(await roleOf(roomId, carolId)).toBe("member");
  });

  test("REQ-200 is idempotent — second run affects zero rows", async () => {
    const aliceId = await seedUser(`alice-${randomUUID().slice(0, 8)}`);
    const roomId = await seedRoom("idempotency-room", aliceId);
    await seedMember(roomId, aliceId, "member");

    const migration = loadMigration();
    const first = await getTestPool().query(migration);
    const second = await getTestPool().query(migration);

    expect(first.rowCount).toBeGreaterThanOrEqual(1);
    expect(second.rowCount).toBe(0);
    expect(await roleOf(roomId, aliceId)).toBe("owner");
  });

  test("REQ-200 already-owner rows are not re-touched (pre-c84948c-safe)", async () => {
    // Since c84948c, rooms.ts create handler writes role='owner' for the
    // creator directly. The backfill must be a no-op against those rows so
    // it's safe to re-run on fresh DBs.
    const aliceId = await seedUser(`alice-${randomUUID().slice(0, 8)}`);
    const roomId = await seedRoom("fresh-room", aliceId);
    await seedMember(roomId, aliceId, "owner"); // post-c84948c state

    const res = await getTestPool().query(loadMigration());

    expect(res.rowCount).toBe(0);
    expect(await roleOf(roomId, aliceId)).toBe("owner");
  });
});
