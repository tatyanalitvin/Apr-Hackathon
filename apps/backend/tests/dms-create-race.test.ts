import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// Concurrent find-or-create race — REQ-061 R1 tail. 20 parallel POSTs
// with the same target MUST collapse to a single room. Some responses
// win 201 (inserter), the rest 200 (idempotent find or post-conflict
// re-SELECT). Zero 5xx. Zero duplicate rooms.
//
// Why 20 — enough to reliably interleave on a pg pool of 10; small
// enough to keep the test under a second. The race path we're guarding
// is the ON CONFLICT (dm_pair_key) WHERE kind='dm' DO NOTHING +
// re-SELECT branch in routes/dms.ts.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { friendship, room, user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

async function register(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<{ agent: request.Agent; userId: string }> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return { agent, userId: row.id };
}

async function makeFriends(a: string, b: string): Promise<void> {
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await getTestDb()
    .insert(friendship)
    .values({ id: randomUUID(), userAId, userBId });
}

describe("REQ-061 R1 concurrent find-or-create", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-061 R1 20 parallel POSTs collapse to one room", async () => {
    const alice = await register(
      app,
      "race-dm-alice@example.com",
      "race_dm_alice",
    );
    const bob = await register(app, "race-dm-bob@example.com", "race_dm_bob");
    await makeFriends(alice.userId, bob.userId);

    const parallel = 20;
    const responses = await Promise.all(
      Array.from({ length: parallel }, () =>
        alice.agent.post("/api/v1/dms").send({ userId: bob.userId }),
      ),
    );

    for (const res of responses) {
      expect([200, 201]).toContain(res.status);
    }

    const roomIds = new Set(responses.map((r) => r.body.roomId as string));
    expect(roomIds.size).toBe(1);

    const [roomId] = [...roomIds];
    const rooms = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.id, roomId as string));
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.kind).toBe("dm");

    // At least one 201 — someone has to be the inserter.
    const creates = responses.filter((r) => r.status === 201);
    expect(creates.length).toBeGreaterThanOrEqual(1);
    // And at least one 200 — the rest lost the race.
    const finds = responses.filter((r) => r.status === 200);
    expect(finds.length).toBeGreaterThanOrEqual(1);
  });
});
