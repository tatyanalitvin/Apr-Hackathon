// REQ-023 / REQ-015 / REQ-021 (CI collision at runtime) integration tests
// for POST /api/v1/rooms. Binding spec: docs/specs/s1-rooms.md §4 R4/R5/R6/R15.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  message,
  messageSeq,
  room,
  roomMember,
  user,
} from "@ai-herders/shared/schema";

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

describe("REQ-023 POST /api/v1/rooms", () => {
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

  test("REQ-023 no cookie → 401 unauthorized", async () => {
    const res = await request(app.server)
      .post("/api/v1/rooms")
      .send({ name: "Unauth Room" });
    expect(res.status).toBe(401);
  });

  test("REQ-023 happy path — 201 + room + room_member(owner) + message_seq rows", async () => {
    const alice = await registerAgent(app, "r023a@example.com", "r023_a");
    const res = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "Book Club", description: "We meet Tuesdays." });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "Book Club",
      description: "We meet Tuesdays.",
      visibility: "public",
      ownerId: alice.userId,
    });
    expect(typeof res.body.id).toBe("string");
    expect(typeof res.body.createdAt).toBe("string");

    const roomId = res.body.id as string;

    const [roomRow] = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.id, roomId));
    expect(roomRow).toMatchObject({
      name: "Book Club",
      description: "We meet Tuesdays.",
      kind: "group",
      visibility: "public",
      ownerId: alice.userId,
      dmPairKey: null,
    });

    const [memberRow] = await getTestDb()
      .select()
      .from(roomMember)
      .where(
        and(eq(roomMember.userId, alice.userId), eq(roomMember.roomId, roomId)),
      );
    expect(memberRow).toMatchObject({
      userId: alice.userId,
      roomId,
      role: "owner",
    });

    const [seqRow] = await getTestDb()
      .select()
      .from(messageSeq)
      .where(eq(messageSeq.roomId, roomId));
    expect(seqRow).toBeDefined();
    expect(seqRow?.seq).toBe(0n);
  });

  test("REQ-015 response body has exactly the documented keys (no internal fields)", async () => {
    const alice = await registerAgent(app, "r015@example.com", "r015_a");
    const res = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "Shape Room" });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(
      ["createdAt", "description", "id", "name", "ownerId", "visibility"].sort(),
    );
    // Negative assertions — none of these must leak.
    expect(res.body).not.toHaveProperty("deletedAt");
    expect(res.body).not.toHaveProperty("dmPairKey");
    expect(res.body).not.toHaveProperty("kind");
  });

  // REQ-088 (docs/specs/s2-invitations.md §4 R2) supersedes the former
  // "REQ-023 forces visibility=public" clamp — visibility now honors client
  // input. Kept here as a regression guard that visibility=private is accepted
  // and written through (the full R1/R2 suite lives in private-rooms.test.ts).
  test("REQ-088 honors client-supplied visibility=private (supersedes REQ-023 clamp)", async () => {
    const alice = await registerAgent(app, "r023pv@example.com", "r023_pv");
    const res = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "Visibility Test", visibility: "private" });
    expect(res.status).toBe(201);
    expect(res.body.visibility).toBe("private");
  });

  test("REQ-023 invalid body (name too short) → 400", async () => {
    const alice = await registerAgent(app, "r023v@example.com", "r023_v");
    const res = await alice.agent.post("/api/v1/rooms").send({ name: "hi" });
    expect(res.status).toBe(400);
  });

  test("REQ-021 case-insensitive duplicate name → 409 name_taken", async () => {
    const alice = await registerAgent(app, "r021a@example.com", "r021_a");
    const first = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "Book Club R021" });
    expect(first.status).toBe(201);

    // Same-case duplicate — must hit the new CI index, NOT the old unique.
    const same = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "Book Club R021" });
    expect(same.status).toBe(409);
    expect(same.body).toMatchObject({ error: "name_taken" });

    // Case-variant duplicate — must also 409.
    const bob = await registerAgent(app, "r021b@example.com", "r021_b");
    const variant = await bob.agent
      .post("/api/v1/rooms")
      .send({ name: "book club r021" });
    expect(variant.status).toBe(409);
    expect(variant.body).toMatchObject({ error: "name_taken" });

    // Exactly one row across the whole cluster.
    const rows = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.name, "Book Club R021"));
    expect(rows).toHaveLength(1);
  });

  test("REQ-022 description control-chars are stripped on the server side", async () => {
    const alice = await registerAgent(app, "r022@example.com", "r022_a");
    const res = await alice.agent.post("/api/v1/rooms").send({
      name: "R022 Room",
      description: "hello\u0007world",
    });
    expect(res.status).toBe(201);
    expect(res.body.description).toBe("helloworld");

    const [roomRow] = await getTestDb()
      .select()
      .from(room)
      .where(eq(room.id, res.body.id));
    expect(roomRow?.description).toBe("helloworld");
  });

  // Defensive: make sure message table isn't accidentally pre-populated.
  test("REQ-023 fresh room has zero messages", async () => {
    const alice = await registerAgent(app, "r023z@example.com", "r023_z");
    const res = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "Empty Room" });
    expect(res.status).toBe(201);
    const messages = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.roomId, res.body.id));
    expect(messages).toHaveLength(0);
  });
});
