import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// Gate-3 demo patch — GET /api/v1/rooms/:id/members.
// Returns the caller-visible roster so RoomClient can key PresencePill on
// real user.id values (not seeded placeholders). Membership is required:
// non-members 403 so DM rosters (kind='dm') can't be enumerated by id.
// Check order mirrors DELETE /rooms/:id/members/me: auth → 404 unknown room
// → 403 non-member → 200 roster.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { room, roomMember, user } from "@ai-herders/shared/schema";

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

async function insertRoom(
  name: string | null,
  kind: "group" | "dm",
  visibility: "public" | "private",
): Promise<string> {
  const id = randomUUID();
  await getTestDb().insert(room).values({ id, name, kind, visibility });
  return id;
}

async function addMember(roomId: string, userId: string): Promise<void> {
  await getTestDb()
    .insert(roomMember)
    .values({ id: randomUUID(), roomId, userId });
}

describe("GET /api/v1/rooms/:id/members", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("no cookie → 401 unauthorized", async () => {
    const res = await request(app.server).get(
      `/api/v1/rooms/${randomUUID()}/members`,
    );
    expect(res.status).toBe(401);
  });

  test("unknown room → 404 room_not_found", async () => {
    const alice = await registerAgent(app, "r-members-a@example.com", "rm_a");
    void alice;
    const res = await alice.agent.get(
      `/api/v1/rooms/${randomUUID()}/members`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("room_not_found");
  });

  test("non-member → 403 room_not_member", async () => {
    const alice = await registerAgent(app, "r-members-b@example.com", "rm_b");
    const roomId = await insertRoom("rm-private", "group", "public");
    // intentionally do NOT add alice — she must be rejected.
    const res = await alice.agent.get(`/api/v1/rooms/${roomId}/members`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("room_not_member");
  });

  test("member → 200 roster with real id/username/displayName, sorted by username", async () => {
    const alice = await registerAgent(app, "r-members-c1@example.com", "rm_alice");
    const bob = await registerAgent(app, "r-members-c2@example.com", "rm_bob");
    const carol = await registerAgent(app, "r-members-c3@example.com", "rm_carol");
    const roomId = await insertRoom("rm-three", "group", "public");
    // insert out of username-alphabetical order to prove the SQL sort, not
    // insertion order, is what the client sees.
    await addMember(roomId, carol.userId);
    await addMember(roomId, alice.userId);
    await addMember(roomId, bob.userId);

    const res = await alice.agent.get(`/api/v1/rooms/${roomId}/members`);
    expect(res.status).toBe(200);
    const members = res.body.members as Array<{
      id: string;
      username: string;
      displayName: string;
      role: string;
    }>;
    // REQ-209 — roster now carries `role`; the seeded harness inserts rows
    // via addMember() which defaults to role='member'. Alphabetical sort
    // on username is the authoritative ordering contract.
    expect(members).toEqual([
      { id: alice.userId, username: "rm_alice", displayName: "rm_alice", role: "member" },
      { id: bob.userId, username: "rm_bob", displayName: "rm_bob", role: "member" },
      { id: carol.userId, username: "rm_carol", displayName: "rm_carol", role: "member" },
    ]);
  });
});
