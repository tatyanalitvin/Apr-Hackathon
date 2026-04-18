// REQ-049 — demo fixture for the S1 gate.
//
// Invoked via `pnpm db:seed` (wired in apps/backend/package.json). Creates
// three users (alice/bob/carol) via `auth.api.signUpEmail` so password hashes
// match production, a single `general` room owned by alice, three room_member
// rows, and three seed messages. Re-running is a no-op (idempotent by
// username / room.id / per-room message count) — the test in
// apps/backend/tests/seed.test.ts asserts this contract.
//
// Why `auth.api.signUpEmail` rather than raw INSERT: better-auth hashes
// passwords with scrypt + writes the `account` row that sign-in later reads.
// A raw INSERT would leave sign-in broken and the S1 demo unable to log in.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { auth } from "../apps/backend/src/auth";
import { db, pool } from "../apps/backend/src/db";
import { allocateAndInsertMessage } from "../apps/backend/src/lib/seq-allocator";
import { closeSecondaryStorage } from "../apps/backend/src/secondary-storage";
import {
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

interface SeedUser {
  email: string;
  username: string;
  name: string;
}

const USERS: readonly SeedUser[] = [
  { email: "alice@herders.local", username: "alice", name: "Alice" },
  { email: "bob@herders.local", username: "bob", name: "Bob" },
  { email: "carol@herders.local", username: "carol", name: "Carol" },
];

const PASSWORD = "hunter2hunter2";
const ROOM_ID = "general";
const ROOM_NAME = "general";

const SEED_MESSAGES: ReadonlyArray<{ author: string; body: string }> = [
  { author: "alice", body: "Welcome to #general — this is the S1 demo room." },
  { author: "bob", body: "Heartbeat check from Bob." },
  { author: "carol", body: "History should survive a restart." },
];

export interface SeedReport {
  createdUsers: number;
  createdRoom: boolean;
  createdMembers: number;
  createdMessages: number;
}

export async function runSeed(): Promise<SeedReport> {
  const report: SeedReport = {
    createdUsers: 0,
    createdRoom: false,
    createdMembers: 0,
    createdMessages: 0,
  };

  const userIds: Record<string, string> = {};

  for (const u of USERS) {
    const [existing] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.username, u.username))
      .limit(1);
    if (existing) {
      userIds[u.username] = existing.id;
      continue;
    }
    await auth.api.signUpEmail({
      body: {
        email: u.email,
        password: PASSWORD,
        name: u.name,
        username: u.username,
      },
    });
    const [created] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.username, u.username))
      .limit(1);
    if (!created) {
      throw new Error(`seed: user ${u.username} not found after signUpEmail`);
    }
    userIds[u.username] = created.id;
    report.createdUsers += 1;
  }

  const aliceId = userIds["alice"];
  if (!aliceId) throw new Error("seed: alice id missing after user loop");

  const roomRows = await db
    .insert(room)
    .values({
      id: ROOM_ID,
      name: ROOM_NAME,
      kind: "group",
      visibility: "public",
      ownerId: aliceId,
    })
    .onConflictDoNothing({ target: room.id })
    .returning({ id: room.id });
  if (roomRows.length > 0) report.createdRoom = true;

  await db
    .insert(messageSeq)
    .values({ roomId: ROOM_ID, seq: 0n })
    .onConflictDoNothing({ target: messageSeq.roomId });

  for (const u of USERS) {
    const memberRows = await db
      .insert(roomMember)
      .values({
        id: randomUUID(),
        userId: userIds[u.username]!,
        roomId: ROOM_ID,
      })
      .onConflictDoNothing({
        target: [roomMember.userId, roomMember.roomId],
      })
      .returning({ id: roomMember.id });
    if (memberRows.length > 0) report.createdMembers += 1;
  }

  const [existingCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(message)
    .where(eq(message.roomId, ROOM_ID));
  if ((existingCount?.count ?? 0) === 0) {
    for (const m of SEED_MESSAGES) {
      const profile = USERS.find((u) => u.username === m.author);
      if (!profile) throw new Error(`seed: no profile for ${m.author}`);
      await allocateAndInsertMessage({
        messageId: randomUUID(),
        roomId: ROOM_ID,
        authorId: userIds[m.author]!,
        authorUsername: profile.username,
        authorName: profile.name,
        body: m.body,
        replyToId: null,
        clientMessageId: null,
      });
      report.createdMessages += 1;
    }
  }

  return report;
}

async function main() {
  const report = await runSeed();
  // eslint-disable-next-line no-console
  console.log("[seed] done", report);
  await pool.end();
  // Close the better-auth rate-limit Redis handle so the script exits —
  // required for `depends_on.seed: service_completed_successfully` in compose.
  await closeSecondaryStorage();
}

// Invoked directly via `tsx scripts/seed.ts` / `pnpm db:seed`.
// Importing the module (e.g. from tests) must NOT trigger main().
const invokedDirectly =
  typeof process !== "undefined" &&
  typeof import.meta !== "undefined" &&
  import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[seed] failed", err);
    process.exit(1);
  });
}
