// REQ-027 integration tests for DELETE /api/v1/rooms/:id/members/me.
// Binding spec: docs/specs/s1-rooms.md §4 R9/R10/R11/R12/R13.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { room, roomMember, user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { flushRedis, getTestDb } from "./db-helpers";

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
    .send({ email, username, password: "password1234", name: username })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

async function createRoomAsOwner(
  app: FastifyInstance,
  email: string,
  username: string,
  name: string,
): Promise<{ agent: request.Agent; userId: string; roomId: string }> {
  const owner = await registerAgent(app, email, username);
  const res = await owner.agent.post("/api/v1/rooms").send({ name });
  if (res.status !== 201) {
    throw new Error(`failed to create room ${name}: ${res.status}`);
  }
  return { ...owner, roomId: res.body.id as string };
}

describe("REQ-027 DELETE /api/v1/rooms/:id/members/me", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await flushRedis();
  });

  test("REQ-027 no cookie → 401", async () => {
    const res = await request(app.server).delete(
      "/api/v1/rooms/some-room-id/members/me",
    );
    expect(res.status).toBe(401);
  });

  test("REQ-027 member leaves → 204 + row deleted, other memberships intact", async () => {
    const anna = await createRoomAsOwner(
      app,
      "r027ao@example.com",
      "r027_ao",
      "R027 Anna Room",
    );
    const bob = await registerAgent(app, "r027bm@example.com", "r027_bm");
    // Bob joins anna's room.
    const joinRes = await bob.agent.post(
      `/api/v1/rooms/${anna.roomId}/join`,
    );
    expect(joinRes.status).toBe(200);

    // Bob also joins the seeded 'general' room so we can check we don't
    // delete unrelated memberships.
    const [generalRow] = await getTestDb()
      .select({ id: room.id })
      .from(room)
      .where(eq(room.name, "general"))
      .limit(1);
    if (generalRow) {
      await bob.agent.post(`/api/v1/rooms/${generalRow.id}/join`);
    }

    const res = await bob.agent.delete(
      `/api/v1/rooms/${anna.roomId}/members/me`,
    );
    expect(res.status).toBe(204);

    const removed = await getTestDb()
      .select()
      .from(roomMember)
      .where(
        and(eq(roomMember.userId, bob.userId), eq(roomMember.roomId, anna.roomId)),
      );
    expect(removed).toHaveLength(0);

    if (generalRow) {
      const untouched = await getTestDb()
        .select()
        .from(roomMember)
        .where(
          and(
            eq(roomMember.userId, bob.userId),
            eq(roomMember.roomId, generalRow.id),
          ),
        );
      expect(untouched).toHaveLength(1);
    }
  });

  test("REQ-027 idempotent: leaving a room the caller was never a member of → 204", async () => {
    // Anna owns a room; Charlie never joins; Charlie calls leave.
    const anna = await createRoomAsOwner(
      app,
      "r027ai@example.com",
      "r027_ai",
      "R027 Idempotent Room",
    );
    const charlie = await registerAgent(app, "r027ci@example.com", "r027_ci");

    const res = await charlie.agent.delete(
      `/api/v1/rooms/${anna.roomId}/members/me`,
    );
    expect(res.status).toBe(204);

    // DB: anna's owner row unaffected; charlie has no row.
    const ownerRow = await getTestDb()
      .select()
      .from(roomMember)
      .where(
        and(
          eq(roomMember.userId, anna.userId),
          eq(roomMember.roomId, anna.roomId),
        ),
      );
    expect(ownerRow).toHaveLength(1);

    const charlieRow = await getTestDb()
      .select()
      .from(roomMember)
      .where(
        and(
          eq(roomMember.userId, charlie.userId),
          eq(roomMember.roomId, anna.roomId),
        ),
      );
    expect(charlieRow).toHaveLength(0);
  });

  test("REQ-027 leaving twice on same existing room → 204 both times, no row count change", async () => {
    const anna = await createRoomAsOwner(
      app,
      "r027a2@example.com",
      "r027_a2",
      "R027 Twice Room",
    );
    const bob = await registerAgent(app, "r027b2@example.com", "r027_b2");
    await bob.agent.post(`/api/v1/rooms/${anna.roomId}/join`).expect(200);

    const first = await bob.agent.delete(
      `/api/v1/rooms/${anna.roomId}/members/me`,
    );
    expect(first.status).toBe(204);

    const second = await bob.agent.delete(
      `/api/v1/rooms/${anna.roomId}/members/me`,
    );
    expect(second.status).toBe(204);
  });

  test("REQ-027 owner-cannot-leave → 403, row preserved", async () => {
    const anna = await createRoomAsOwner(
      app,
      "r027o@example.com",
      "r027_o",
      "R027 Owner Room",
    );
    const res = await anna.agent.delete(
      `/api/v1/rooms/${anna.roomId}/members/me`,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "owner_cannot_leave" });

    const rows = await getTestDb()
      .select()
      .from(roomMember)
      .where(
        and(
          eq(roomMember.userId, anna.userId),
          eq(roomMember.roomId, anna.roomId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("owner");
  });

  test("REQ-027 room-not-found (random UUID with no room row) → 404", async () => {
    const bob = await registerAgent(app, "r027n@example.com", "r027_n");
    const res = await bob.agent.delete(
      "/api/v1/rooms/00000000-0000-0000-0000-deadbeef0000/members/me",
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "room_not_found" });
  });
});
