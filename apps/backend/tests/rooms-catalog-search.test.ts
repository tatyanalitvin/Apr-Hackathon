// REQ-025 / §2.4.3 — GET /api/v1/rooms?q=<term>.
// Binding spec: docs/specs/s2-catalog-emoji-unread.md §4 R1/R1b/R2/R3.
//
// Simple case-insensitive ILIKE 'contains' filter on room.name. Existing
// `kind='group' AND visibility='public'` gate is preserved — private rooms
// (even those owned by the caller) must never surface via search, or §2.4.3
// becomes a private-room enumeration oracle. `q` omitted / empty / whitespace-
// only degrades to the unfiltered path (back-compat with existing REQ-025
// callers and with the current `listRoomCatalog()` web shape).
//
// Companion fixtures + helpers mirror rooms-catalog.test.ts; kept duplicated
// rather than lifting to a shared module because the only dependency is
// insertRoom / registerAgent, both of which are ~10 lines each.

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
    .send({ email, username, password: "password1234", name: username })
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

describe("REQ-025 GET /api/v1/rooms §2.4.3 — simple ILIKE search via ?q", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-025 §2.4.3 R1 — ?q=eng returns only rooms whose name contains 'eng' (case-insensitive)", async () => {
    const alice = await registerAgent(app, "rq1-a@example.com", "rq1_a");
    await insertRoom("rq1-general", "group", "public");
    const engineering = await insertRoom("rq1-Engineering", "group", "public");
    await insertRoom("rq1-random", "group", "public");

    const res = await alice.agent.get("/api/v1/rooms?q=eng");
    expect(res.status).toBe(200);
    const ids = (res.body.rooms as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual([engineering]);
  });

  test("REQ-025 §2.4.3 R1 — ?q=XYZ returns empty when nothing matches", async () => {
    const alice = await registerAgent(app, "rq2-a@example.com", "rq2_a");
    await insertRoom("rq2-general", "group", "public");
    await insertRoom("rq2-engineering", "group", "public");

    const res = await alice.agent.get("/api/v1/rooms?q=XYZ-no-match");
    expect(res.status).toBe(200);
    expect(res.body.rooms).toEqual([]);
  });

  test("REQ-025 §2.4.3 R1 — omitted q returns all public-group rooms (back-compat)", async () => {
    const alice = await registerAgent(app, "rq3-a@example.com", "rq3_a");
    const r1 = await insertRoom("rq3-alpha", "group", "public");
    const r2 = await insertRoom("rq3-bravo", "group", "public");

    const res = await alice.agent.get("/api/v1/rooms");
    expect(res.status).toBe(200);
    const ids = (res.body.rooms as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([r1, r2]));
    expect(ids).toHaveLength(2);
  });

  test("REQ-025 §2.4.3 R1 — empty q string degrades to unfiltered response", async () => {
    const alice = await registerAgent(app, "rq4-a@example.com", "rq4_a");
    const r1 = await insertRoom("rq4-foo", "group", "public");

    const res = await alice.agent.get("/api/v1/rooms?q=");
    expect(res.status).toBe(200);
    const ids = (res.body.rooms as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual([r1]);
  });

  test("REQ-025 §2.4.3 R1b — whitespace-only q degrades to unfiltered response (same as omitted)", async () => {
    const alice = await registerAgent(app, "rq5-a@example.com", "rq5_a");
    const r1 = await insertRoom("rq5-baz", "group", "public");

    const res = await alice.agent.get("/api/v1/rooms?q=%20%20%20");
    expect(res.status).toBe(200);
    const ids = (res.body.rooms as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual([r1]);
  });

  test("REQ-025 §2.4.3 R2 — q longer than 64 chars returns 400 invalid_query", async () => {
    const alice = await registerAgent(app, "rq6-a@example.com", "rq6_a");
    const tooLong = "a".repeat(65);

    const res = await alice.agent.get(`/api/v1/rooms?q=${tooLong}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  test("REQ-025 §2.4.3 R3 — private room whose name matches q does NOT leak into search", async () => {
    const alice = await registerAgent(app, "rq7-a@example.com", "rq7_a");
    // public room that will match — this is what SHOULD come back
    const publicTeam = await insertRoom("rq7-team-public", "group", "public");
    // private room that also matches — this MUST stay hidden even though
    // alice is a member (private rooms surface via /rooms/me, never /rooms).
    const privateTeam = await insertRoom("rq7-core-team", "group", "private");
    await addMember(privateTeam, alice.userId);

    const res = await alice.agent.get("/api/v1/rooms?q=team");
    expect(res.status).toBe(200);
    const ids = (res.body.rooms as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual([publicTeam]);
    expect(ids).not.toContain(privateTeam);
  });

  test("REQ-025 §2.4.3 — existing ordering (memberCount DESC, name ASC) preserved under ?q", async () => {
    const alice = await registerAgent(app, "rq8-a@example.com", "rq8_a");
    const bob = await registerAgent(app, "rq8-a2@example.com", "rq8_a2");
    // All match ?q=match; big has 2 members, others 0.
    const big = await insertRoom("rq8-match-zulu", "group", "public");
    const smallAlpha = await insertRoom("rq8-match-alpha", "group", "public");
    const smallBravo = await insertRoom("rq8-match-bravo", "group", "public");
    await addMember(big, alice.userId);
    await addMember(big, bob.userId);

    const res = await alice.agent.get("/api/v1/rooms?q=match");
    expect(res.status).toBe(200);
    const ids = (res.body.rooms as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual([big, smallAlpha, smallBravo]);
  });
});
