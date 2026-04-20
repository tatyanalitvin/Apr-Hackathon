import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// POST /api/v1/dms — REQ-060 precondition + REQ-061 find-or-create.
// Binding spec: docs/specs/s2-dms.md §4 R1 happy path + idempotent re-POST,
// plus R4 gate branches (not-friends / blocked / self / unknown user).
// REQ-063 (2-member cap) + REQ-064 (no admin) asserted incidentally in the
// happy path; dedicated membership test lives in dms-membership.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  friendship,
  messageSeq,
  room,
  roomMember,
  user,
  userBlock,
} from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

interface SignedUpAgent {
  agent: request.Agent;
  userId: string;
}

async function userIdByEmail(email: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return row.id;
}

async function registerAgent(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<SignedUpAgent> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

// Direct DB insert of a normalized friendship row (spec §5 — friendship
// ordering userAId < userBId). We don't drive R1+R8 from the friendship spec
// here; that's an integration detour. The freeze predicate reads this table,
// which is all we need.
async function makeFriends(a: string, b: string): Promise<void> {
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await getTestDb()
    .insert(friendship)
    .values({ id: randomUUID(), userAId, userBId });
}

async function block(byId: string, targetId: string): Promise<void> {
  await getTestDb()
    .insert(userBlock)
    .values({ id: randomUUID(), byId, targetId });
}

describe("REQ-061 POST /api/v1/dms find-or-create (R1 + R4)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-061 R12 no cookie → 401 unauthorized", async () => {
    const res = await request(app.server)
      .post("/api/v1/dms")
      .send({ userId: "any" });
    expect(res.status).toBe(401);
  });

  test("REQ-061 R1 friends + first call → 201 creates room + 2 members + messageSeq row", async () => {
    const alice = await registerAgent(
      app,
      "r1-dm-alice@example.com",
      "r1_dm_alice",
    );
    const bob = await registerAgent(
      app,
      "r1-dm-bob@example.com",
      "r1_dm_bob",
    );
    await makeFriends(alice.userId, bob.userId);

    const res = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: "dm" });
    expect(typeof res.body.roomId).toBe("string");
    expect(res.body.roomId.length).toBeGreaterThan(0);
    expect(typeof res.body.dmPairKey).toBe("string");
    expect(res.body.dmPairKey).toContain(":");

    const roomId = res.body.roomId as string;
    const [roomRow] = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.id, roomId));
    expect(roomRow).toBeDefined();
    expect(roomRow!.kind).toBe("dm");
    expect(roomRow!.visibility).toBe("private");
    expect(roomRow!.name).toBeNull();
    // REQ-064 — no DM admins; ownerId MUST be NULL on DM rooms.
    expect(roomRow!.ownerId).toBeNull();

    // REQ-063 — exactly 2 members, both 'member' role.
    const members = await getTestDb()
      .select()
      .from(roomMember)
      .where(eq(roomMember.roomId, roomId));
    expect(members).toHaveLength(2);
    const memberIds = new Set(members.map((m) => m.userId));
    expect(memberIds.has(alice.userId)).toBe(true);
    expect(memberIds.has(bob.userId)).toBe(true);
    for (const m of members) expect(m.role).toBe("member");

    // messageSeq bootstrap — the allocator demands the row exist.
    const [seqRow] = await getTestDb()
      .select()
      .from(messageSeq)
      .where(eq(messageSeq.roomId, roomId));
    expect(seqRow).toBeDefined();
    expect(seqRow!.seq).toBe(0n);
  });

  test("REQ-061 R1 re-POST same pair → 200 returns same roomId (idempotent)", async () => {
    const alice = await registerAgent(
      app,
      "r1-dm-alice2@example.com",
      "r1_dm_alice2",
    );
    const bob = await registerAgent(
      app,
      "r1-dm-bob2@example.com",
      "r1_dm_bob2",
    );
    await makeFriends(alice.userId, bob.userId);

    const first = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(first.status).toBe(201);
    const firstId = first.body.roomId as string;

    const second = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(second.status).toBe(200);
    expect(second.body.roomId).toBe(firstId);

    // Only one DM room for this pair.
    const rooms = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.dmPairKey, second.body.dmPairKey));
    expect(rooms).toHaveLength(1);
  });

  test("REQ-061 R1 reverse-direction re-POST (bob→alice) hits same room", async () => {
    // Canonicalization means the pair key is the same regardless of who
    // initiated. Guards against a future regression where caller order leaks
    // into the key.
    const alice = await registerAgent(
      app,
      "r1-dm-alice3@example.com",
      "r1_dm_alice3",
    );
    const bob = await registerAgent(
      app,
      "r1-dm-bob3@example.com",
      "r1_dm_bob3",
    );
    await makeFriends(alice.userId, bob.userId);

    const first = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(first.status).toBe(201);
    const roomId = first.body.roomId as string;

    const second = await bob.agent
      .post("/api/v1/dms")
      .send({ userId: alice.userId });
    expect(second.status).toBe(200);
    expect(second.body.roomId).toBe(roomId);
  });

  test("REQ-060 R4 not-friends → 403 dm_not_allowed (no room created)", async () => {
    const alice = await registerAgent(
      app,
      "r4-dm-a@example.com",
      "r4_dm_a",
    );
    const bob = await registerAgent(
      app,
      "r4-dm-b@example.com",
      "r4_dm_b",
    );
    // No friendship row.

    const res = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "dm_not_allowed" });

    const rooms = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.kind, "dm"));
    expect(rooms).toHaveLength(0);
  });

  test("REQ-060 R4 friends + caller-blocks-target → 403 dm_not_allowed (REQ-073 effect 4)", async () => {
    const alice = await registerAgent(
      app,
      "r4-dm-a2@example.com",
      "r4_dm_a2",
    );
    const bob = await registerAgent(
      app,
      "r4-dm-b2@example.com",
      "r4_dm_b2",
    );
    await makeFriends(alice.userId, bob.userId);
    await block(alice.userId, bob.userId);

    const res = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "dm_not_allowed" });

    const rooms = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.kind, "dm"));
    expect(rooms).toHaveLength(0);
  });

  test("REQ-060 R4 friends + target-blocks-caller → 403 dm_not_allowed", async () => {
    const alice = await registerAgent(
      app,
      "r4-dm-a3@example.com",
      "r4_dm_a3",
    );
    const bob = await registerAgent(
      app,
      "r4-dm-b3@example.com",
      "r4_dm_b3",
    );
    await makeFriends(alice.userId, bob.userId);
    await block(bob.userId, alice.userId);

    const res = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "dm_not_allowed" });
  });

  test("REQ-061 R1 self-DM → 400 self_dm", async () => {
    const alice = await registerAgent(
      app,
      "r1-dm-self@example.com",
      "r1_dm_self",
    );

    const res = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: alice.userId });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "self_dm" });

    const rooms = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.kind, "dm"));
    expect(rooms).toHaveLength(0);
  });

  test("REQ-060 R4 unknown target userId → 403 dm_not_allowed (Q4b enumeration-symmetric)", async () => {
    const alice = await registerAgent(
      app,
      "r4-dm-unknown@example.com",
      "r4_dm_unknown",
    );

    const res = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: "ghost-id-that-does-not-exist" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "dm_not_allowed" });
  });

  test("REQ-061 R1 invalid body shape → 400 validation", async () => {
    const alice = await registerAgent(
      app,
      "r1-dm-bad@example.com",
      "r1_dm_bad",
    );

    const res = await alice.agent.post("/api/v1/dms").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation");
  });

  test("REQ-066 R4 soft-deleted target → 403 dm_not_allowed (defense in depth vs Q6)", async () => {
    // Q6(b) fallback — if someone soft-deleted their account, new DMs with
    // them MUST be refused. Existing rooms are still listed (R11) but no
    // new ones are created. Flagged in spec §8 Q6.
    const alice = await registerAgent(
      app,
      "r4-dm-dead-a@example.com",
      "r4_dm_dead_a",
    );
    const bob = await registerAgent(
      app,
      "r4-dm-dead-b@example.com",
      "r4_dm_dead_b",
    );
    await makeFriends(alice.userId, bob.userId);
    // Direct soft-delete — better-auth's flow is orthogonal to this test.
    await getTestDb()
      .update(user)
      .set({ deletedAt: new Date() })
      .where(eq(user.id, bob.userId));

    const res = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "dm_not_allowed" });

    // Sanity — friendship left intact (ownership of soft-delete cleanup
    // belongs to REQ-125 / s2-account-deletion).
    const [fr] = await getTestDb()
      .select()
      .from(friendship)
      .where(
        and(
          eq(friendship.userAId, alice.userId < bob.userId ? alice.userId : bob.userId),
          eq(friendship.userBId, alice.userId < bob.userId ? bob.userId : alice.userId),
        ),
      );
    expect(fr).toBeDefined();
  });
});
