import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// R3 / REQ-025 — GET /api/v1/rooms.
// Binding spec: docs/specs/s2-rooms.md §4 R3.
//
// Returns { rooms: [{ id, name, kind, visibility, memberCount, isMember }] }
// filtered strictly to kind='group' AND visibility='public'. Private rooms
// and DM rooms never surface here (Q2 pre-resolved: private rooms the caller
// belongs to surface via /rooms/me, not /rooms). Ordered by
// memberCount DESC, name ASC. isMember is true iff caller has a room_member
// row for that roomId. 401 without session.

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

describe("REQ-025 GET /api/v1/rooms", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-025 no cookie → 401 unauthorized", async () => {
    const res = await request(app.server).get("/api/v1/rooms");
    expect(res.status).toBe(401);
  });

  test("REQ-025 filters to kind=group AND visibility=public — private + dm rooms excluded", async () => {
    const alice = await registerAgent(app, "r025-a@example.com", "r025_a");
    const pub1 = await insertRoom("r025-pub-1", "group", "public");
    await insertRoom("r025-priv-1", "group", "private");
    await insertRoom(null, "dm", "private");

    const res = await alice.agent.get("/api/v1/rooms");
    expect(res.status).toBe(200);
    const ids = (res.body.rooms as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual([pub1]);
  });

  test("REQ-025 isMember derivation — true only for rooms the caller is a member of", async () => {
    const alice = await registerAgent(app, "r025-b@example.com", "r025_b");
    const member = await insertRoom("r025-member", "group", "public");
    const other = await insertRoom("r025-other", "group", "public");
    await addMember(member, alice.userId);

    const res = await alice.agent.get("/api/v1/rooms");
    expect(res.status).toBe(200);
    const byId = new Map(
      (res.body.rooms as Array<{ id: string; isMember: boolean }>).map((r) => [
        r.id,
        r,
      ]),
    );
    expect(byId.get(member)?.isMember).toBe(true);
    expect(byId.get(other)?.isMember).toBe(false);
  });

  test("REQ-025 memberCount counts every room_member row", async () => {
    const alice = await registerAgent(app, "r025-c@example.com", "r025_c");
    const bob = await registerAgent(app, "r025-c2@example.com", "r025_c2");
    const carol = await registerAgent(app, "r025-c3@example.com", "r025_c3");
    const roomId = await insertRoom("r025-three", "group", "public");
    await addMember(roomId, alice.userId);
    await addMember(roomId, bob.userId);
    await addMember(roomId, carol.userId);

    const res = await alice.agent.get("/api/v1/rooms");
    expect(res.status).toBe(200);
    const hit = (res.body.rooms as Array<{ id: string; memberCount: number }>).find(
      (r) => r.id === roomId,
    );
    expect(hit?.memberCount).toBe(3);
  });

  test("REQ-025 ordering — memberCount DESC, then name ASC", async () => {
    const alice = await registerAgent(app, "r025-d@example.com", "r025_d");
    const bob = await registerAgent(app, "r025-d2@example.com", "r025_d2");
    const big = await insertRoom("r025-zulu", "group", "public"); // 2 members
    const smallA = await insertRoom("r025-alpha", "group", "public"); // 1 member
    const smallB = await insertRoom("r025-bravo", "group", "public"); // 1 member
    const empty = await insertRoom("r025-charlie", "group", "public"); // 0
    void empty;
    await addMember(big, alice.userId);
    await addMember(big, bob.userId);
    await addMember(smallA, alice.userId);
    await addMember(smallB, alice.userId);

    const res = await alice.agent.get("/api/v1/rooms");
    expect(res.status).toBe(200);
    const ids = (res.body.rooms as Array<{ id: string; name: string }>).map(
      (r) => r.id,
    );
    // memberCount DESC: big (2) first. Then name ASC within count=1:
    // "r025-alpha" < "r025-bravo". Finally count=0: "r025-charlie".
    expect(ids).toEqual([big, smallA, smallB, empty]);
  });

  test("REQ-025 response shape — each room has id, name, kind, visibility, memberCount, isMember", async () => {
    const alice = await registerAgent(app, "r025-e@example.com", "r025_e");
    await insertRoom("r025-shape", "group", "public");

    const res = await alice.agent.get("/api/v1/rooms");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rooms)).toBe(true);
    const [r0] = res.body.rooms as Array<Record<string, unknown>>;
    expect(r0).toMatchObject({
      name: "r025-shape",
      kind: "group",
      visibility: "public",
      memberCount: 0,
      isMember: false,
    });
    expect(typeof r0.id).toBe("string");
  });
});
