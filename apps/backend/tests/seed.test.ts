// REQ-049 — `pnpm db:seed` idempotent demo fixture.
//
// Runs `runSeed()` against the Testcontainers DB and asserts:
//   1. Fresh DB: creates alice/bob/carol, `general` room, 3 members, 3 messages
//      with contiguous seq 1..3.
//   2. Second invocation is idempotent — counts match, no new rows, seq head
//      stays at 3.
//   3. Passwords hash via better-auth (sign-in against the seeded user
//      succeeds), so the seed matches production credentials rather than
//      diverging via raw INSERT.
//
// The seed script itself lives at `scripts/seed.ts` at the repo root; this
// test imports the exported `runSeed()` helper so we don't shell out to
// `pnpm db:seed` (that would spin up a second process against an unrelated
// DATABASE_URL). The `main()` CLI wrapper in scripts/seed.ts is exercised
// manually via §9 of the spec / gate dry-run.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app";
import { message, messageSeq, room, roomMember, user } from "@ai-herders/shared/schema";
import { getTestDb } from "./db-helpers";
import { runSeed } from "../../../scripts/seed";

const SEED_USERNAMES = ["alice", "bob", "carol"] as const;
const SEED_PASSWORD = "hunter2hunter2";
const SEED_ROOM_ID = "general";

describe("REQ-049 seed script creates demo fixture idempotently", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  test("REQ-049 first run creates alice/bob/carol + general + 3 members + 3 messages with seq 1..3", async () => {
    const report = await runSeed();

    expect(report.createdUsers).toBe(3);
    expect(report.createdRoom).toBe(true);
    expect(report.createdMembers).toBe(3);
    expect(report.createdMessages).toBe(3);

    const db = getTestDb();

    const users = await db
      .select({ id: user.id, username: user.username })
      .from(user)
      .where(inArray(user.username, [...SEED_USERNAMES]));
    expect(users).toHaveLength(3);
    const byUsername = new Map(users.map((u) => [u.username, u.id]));
    for (const uname of SEED_USERNAMES) {
      expect(byUsername.get(uname)).toBeDefined();
    }

    const [generalRoom] = await db
      .select()
      .from(room)
      .where(eq(room.id, SEED_ROOM_ID));
    expect(generalRoom).toBeDefined();
    expect(generalRoom.name).toBe("general");
    expect(generalRoom.kind).toBe("group");
    expect(generalRoom.visibility).toBe("public");
    expect(generalRoom.ownerId).toBe(byUsername.get("alice"));

    const members = await db
      .select()
      .from(roomMember)
      .where(eq(roomMember.roomId, SEED_ROOM_ID));
    expect(members).toHaveLength(3);
    const memberUserIds = new Set(members.map((m) => m.userId));
    for (const uname of SEED_USERNAMES) {
      expect(memberUserIds.has(byUsername.get(uname)!)).toBe(true);
    }

    const msgs = await db
      .select()
      .from(message)
      .where(eq(message.roomId, SEED_ROOM_ID));
    expect(msgs).toHaveLength(3);
    const seqs = msgs.map((m) => m.seq).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(seqs).toEqual([1n, 2n, 3n]);

    const [seqRow] = await db
      .select()
      .from(messageSeq)
      .where(eq(messageSeq.roomId, SEED_ROOM_ID));
    expect(seqRow).toBeDefined();
    expect(seqRow.seq).toBe(3n);
  });

  test("REQ-049 second run is idempotent — no new rows, report shows zero creations", async () => {
    const first = await runSeed();
    expect(first.createdUsers).toBe(3);
    expect(first.createdMessages).toBe(3);

    const db = getTestDb();
    const beforeUsers = await db.select({ id: user.id }).from(user);
    const beforeMembers = await db.select({ id: roomMember.id }).from(roomMember);
    const beforeMsgs = await db.select({ id: message.id }).from(message);
    const beforeRooms = await db.select({ id: room.id }).from(room);

    const second = await runSeed();
    expect(second.createdUsers).toBe(0);
    expect(second.createdRoom).toBe(false);
    expect(second.createdMembers).toBe(0);
    expect(second.createdMessages).toBe(0);

    const afterUsers = await db.select({ id: user.id }).from(user);
    const afterMembers = await db.select({ id: roomMember.id }).from(roomMember);
    const afterMsgs = await db.select({ id: message.id }).from(message);
    const afterRooms = await db.select({ id: room.id }).from(room);

    expect(afterUsers.length).toBe(beforeUsers.length);
    expect(afterMembers.length).toBe(beforeMembers.length);
    expect(afterMsgs.length).toBe(beforeMsgs.length);
    expect(afterRooms.length).toBe(beforeRooms.length);

    const [seqRow] = await db
      .select()
      .from(messageSeq)
      .where(eq(messageSeq.roomId, SEED_ROOM_ID));
    expect(seqRow.seq).toBe(3n);
  });

  test("REQ-049 seed assigns deterministic UUIDs so ADMIN_USER_IDS can be pinned in docker-compose.yml", async () => {
    // The out-of-box /admin experience depends on this contract: alice's
    // user.id must equal the literal committed in docker-compose.yml and
    // .env.example, else `git clone && docker compose up` boots with an
    // empty admin allow-list and the judges see 403 on /admin.
    await runSeed();

    const db = getTestDb();
    const rows = await db
      .select({ username: user.username, id: user.id })
      .from(user)
      .where(inArray(user.username, [...SEED_USERNAMES]));
    const byUsername = new Map(rows.map((r) => [r.username, r.id]));
    expect(byUsername.get("alice")).toBe("00000000-0000-0000-0000-000000000001");
    expect(byUsername.get("bob")).toBe("00000000-0000-0000-0000-000000000002");
    expect(byUsername.get("carol")).toBe("00000000-0000-0000-0000-000000000003");
  });

  test("REQ-049 seeded password hashes via better-auth — sign-in succeeds for alice", async () => {
    await runSeed();

    const signIn = await request(app.server)
      .post("/api/auth/sign-in/email")
      .send({ email: "alice@herders.local", password: SEED_PASSWORD });
    expect(signIn.status).toBe(200);
    expect(signIn.body?.user?.email).toBe("alice@herders.local");
    expect(signIn.body?.user?.username).toBe("alice");
  });
});
