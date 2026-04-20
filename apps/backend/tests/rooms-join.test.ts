import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// R2 / REQ-026 — POST /api/v1/rooms/:id/join.
// Binding spec: docs/specs/s2-rooms.md §4 R2.
//
// Idempotent self-join: first call inserts room_member, returns 200 with
// { joined: true }. Repeat call returns 200 with { joined: false } (ON CONFLICT
// DO NOTHING). 404 on missing room; 403 on private group rooms AND on DM-kind
// rooms (neither is self-joinable); 401 without session.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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

describe("REQ-026 POST /api/v1/rooms/:id/join", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-026 no cookie → 401 unauthorized", async () => {
    const roomId = await insertRoom("r026-public", "group", "public");
    const res = await request(app.server).post(`/api/v1/rooms/${roomId}/join`);
    expect(res.status).toBe(401);
  });

  test("REQ-026 happy path — inserts row, returns 200 with joined=true", async () => {
    const alice = await registerAgent(app, "r026-a@example.com", "r026_a");
    const roomId = await insertRoom("r026-public-a", "group", "public");

    const res = await alice.agent.post(`/api/v1/rooms/${roomId}/join`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ joined: true });

    const rows = await getTestDb()
      .select()
      .from(roomMember)
      .where(
        and(eq(roomMember.userId, alice.userId), eq(roomMember.roomId, roomId)),
      );
    expect(rows).toHaveLength(1);
  });

  test("REQ-026 idempotent repeat — returns 200 with joined=false, no duplicate row", async () => {
    const alice = await registerAgent(app, "r026-b@example.com", "r026_b");
    const roomId = await insertRoom("r026-public-b", "group", "public");

    const first = await alice.agent.post(`/api/v1/rooms/${roomId}/join`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ joined: true });

    const second = await alice.agent.post(`/api/v1/rooms/${roomId}/join`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ joined: false });

    const rows = await getTestDb()
      .select()
      .from(roomMember)
      .where(
        and(eq(roomMember.userId, alice.userId), eq(roomMember.roomId, roomId)),
      );
    expect(rows).toHaveLength(1);
  });

  test("REQ-026 unknown room id → 404 room_not_found", async () => {
    const alice = await registerAgent(app, "r026-c@example.com", "r026_c");

    const res = await alice.agent.post(`/api/v1/rooms/does-not-exist/join`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "room_not_found" });
  });

  test("REQ-026 private group room → 403 room_not_joinable, no row inserted", async () => {
    const alice = await registerAgent(app, "r026-d@example.com", "r026_d");
    const roomId = await insertRoom("r026-private", "group", "private");

    const res = await alice.agent.post(`/api/v1/rooms/${roomId}/join`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "room_not_joinable" });

    const rows = await getTestDb()
      .select()
      .from(roomMember)
      .where(
        and(eq(roomMember.userId, alice.userId), eq(roomMember.roomId, roomId)),
      );
    expect(rows).toHaveLength(0);
  });

  test("REQ-026 DM-kind room → 403 room_not_joinable (DMs are not self-joinable)", async () => {
    const alice = await registerAgent(app, "r026-e@example.com", "r026_e");
    const roomId = await insertRoom(null, "dm", "private");

    const res = await alice.agent.post(`/api/v1/rooms/${roomId}/join`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "room_not_joinable" });
  });
});
