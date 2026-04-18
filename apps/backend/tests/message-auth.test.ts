// Integration test for requireRoomMember (R14, transverse).
// Spec §6 task 3 — verify: no cookie → 401, non-member → 403, member → { userId }.
//
// Uses a test-only faux route registered on buildApp()'s instance before
// app.ready(), so we exercise the helper through Fastify's real request
// pipeline without having to first stand up the /messages routes.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { room, roomMember, user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";
import { requireRoomMember } from "../src/lib/message-auth";

async function userIdByEmail(email: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return row.id;
}

const FAUX_ROUTE = "/api/v1/_test/membership";

describe("R14 requireRoomMember helper (transverse auth+membership)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    app.get<{ Params: { roomId: string } }>(
      `${FAUX_ROUTE}/:roomId`,
      async (req: FastifyRequest<{ Params: { roomId: string } }>, reply: FastifyReply) => {
        const ctx = await requireRoomMember(req, reply, req.params.roomId);
        if (!ctx) return;
        return { userId: ctx.userId };
      },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("R14 no session cookie → 401", async () => {
    const res = await request(app.server).get(`${FAUX_ROUTE}/some-room`);
    expect(res.status).toBe(401);
  });

  test("R14 authenticated but non-member → 403", async () => {
    const agent = request.agent(app.server);
    await agent
      .post("/api/auth/sign-up/email")
      .send({
        email: "r14-nonmember@example.com",
        username: "r14_nonmember",
        password: "password1234",
        name: "R14 Non-member",
      })
      .expect(200);

    // Create a room the caller is NOT a member of.
    await getTestDb().insert(room).values({
      id: "r14-locked-room",
      name: "r14-locked",
      kind: "group",
      visibility: "public",
    });

    const res = await agent.get(`${FAUX_ROUTE}/r14-locked-room`);
    expect(res.status).toBe(403);
  });

  test("R14 authenticated and member → 200 with userId", async () => {
    const agent = request.agent(app.server);
    const email = "r14-member@example.com";
    await agent
      .post("/api/auth/sign-up/email")
      .send({
        email,
        username: "r14_member",
        password: "password1234",
        name: "R14 Member",
      })
      .expect(200);

    const userId = await userIdByEmail(email);

    await getTestDb().insert(room).values({
      id: "r14-open-room",
      name: "r14-open",
      kind: "group",
      visibility: "public",
    });
    await getTestDb().insert(roomMember).values({
      id: "rm-r14-1",
      userId,
      roomId: "r14-open-room",
      role: "member",
    });

    const res = await agent.get(`${FAUX_ROUTE}/r14-open-room`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId });
  });

  test("R14 authenticated, room does not exist → 403 (no oracle)", async () => {
    // Non-existent room must look identical to "exists but you're not in it" so
    // the endpoint is not a room-id enumeration oracle. Matches the rationale
    // sessions.ts:45-47 uses for session-id 403s.
    const agent = request.agent(app.server);
    await agent
      .post("/api/auth/sign-up/email")
      .send({
        email: "r14-ghost@example.com",
        username: "r14_ghost",
        password: "password1234",
        name: "R14 Ghost",
      })
      .expect(200);

    const res = await agent.get(`${FAUX_ROUTE}/does-not-exist`);
    expect(res.status).toBe(403);
  });

  test("R14 requireRoomMember writes the 401 response itself", async () => {
    // Regression guard: handler's `if (!ctx) return;` relies on the helper
    // having already called `reply.status(...).send(...)`. If the helper
    // ever starts returning null without replying, the request hangs.
    // Using a fetch with a timeout would prove it; here we settle for asserting
    // the body shape the helper sends.
    const res = await request(app.server).get(`${FAUX_ROUTE}/any`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });
});
