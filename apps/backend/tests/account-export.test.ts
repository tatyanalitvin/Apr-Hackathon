import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-126 (v3.docx §2.2 "GDPR export") — `POST /api/v1/users/me/export`
// returns a JSON attachment containing every piece of content the caller
// owns: profile, rooms joined, group messages authored, DM threads (grouped
// by peer), friendships, and sessions.
//
// Failing against a not-yet-written route. Commit 8 implements the handler
// + Content-Disposition, using the `UserDataExport` shape fixed in commit 2
// (protocol.ts). Attachments are referenced by id + originalName; the bytes
// stay on disk — REQ-126 is portability of the user's content, not an
// archive format.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { friendship, user } from "@ai-herders/shared/schema";
import type { UserDataExport } from "@ai-herders/shared/protocol";

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

async function makeFriends(a: string, b: string): Promise<void> {
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await getTestDb().insert(friendship).values({ id: randomUUID(), userAId, userBId });
}

describe("REQ-126 POST /api/v1/users/me/export", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-126 returns JSON attachment with all seven top-level keys populated", async () => {
    const alice = await registerAgent(app, "export-alice@example.com", "export_alice");
    const bob = await registerAgent(app, "export-bob@example.com", "export_bob");
    await makeFriends(alice.userId, bob.userId);

    // Alice creates a group room and posts a message in it.
    const roomCreate = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "export-room", description: "for export test" })
      .expect(201);
    const groupRoomId = roomCreate.body.id as string;
    const groupMessageBody = "alice-group-message-export";
    await alice.agent
      .post(`/api/v1/rooms/${groupRoomId}/messages`)
      .send({ body: groupMessageBody })
      .expect(201);

    // Alice opens a DM with bob and posts a message.
    const dm = await alice.agent
      .post("/api/v1/dms")
      .send({ userId: bob.userId })
      .expect(201);
    const dmRoomId = dm.body.roomId as string;
    const dmMessageBody = "alice-dm-message-export";
    await alice.agent
      .post(`/api/v1/rooms/${dmRoomId}/messages`)
      .send({ body: dmMessageBody })
      .expect(201);

    // Fire the export.
    const res = await alice.agent.post("/api/v1/users/me/export");
    expect(res.status).toBe(200);

    // REQ-126 — JSON attachment download (not inline viewing).
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    expect(res.headers["content-disposition"]).toMatch(/\.json/);

    const body = res.body as UserDataExport;

    // Envelope + profile.
    expect(typeof body.exportedAt).toBe("string");
    expect(body.user.id).toBe(alice.userId);
    expect(body.user.email).toBe("export-alice@example.com");
    expect(body.user.username).toBe("export_alice");
    expect(typeof body.user.createdAt).toBe("string");

    // Rooms: at least the group room alice just created.
    expect(Array.isArray(body.rooms)).toBe(true);
    const groupRoomEntry = body.rooms.find((r) => r.id === groupRoomId);
    expect(groupRoomEntry).toBeDefined();
    expect(groupRoomEntry!.name).toBe("export-room");
    expect(groupRoomEntry!.kind).toBe("group");
    expect(typeof groupRoomEntry!.joinedAt).toBe("string");

    // Messages: alice's group-room message must be present by body + roomId.
    expect(Array.isArray(body.messages)).toBe(true);
    const groupMsg = body.messages.find((m) => m.body === groupMessageBody);
    expect(groupMsg).toBeDefined();
    expect(groupMsg!.roomId).toBe(groupRoomId);
    expect(groupMsg!.roomName).toBe("export-room");
    expect(Array.isArray(groupMsg!.attachments)).toBe(true);

    // DMs: one thread with bob carrying the DM message.
    expect(Array.isArray(body.directMessages)).toBe(true);
    const dmThread = body.directMessages.find((d) => d.dmId === dmRoomId);
    expect(dmThread).toBeDefined();
    expect(dmThread!.peerUsername).toBe("export_bob");
    const dmMsg = dmThread!.messages.find((m) => m.body === dmMessageBody);
    expect(dmMsg).toBeDefined();

    // Friendships: bob shows up by username.
    expect(Array.isArray(body.friendships)).toBe(true);
    const bobFriend = body.friendships.find((f) => f.friendUsername === "export_bob");
    expect(bobFriend).toBeDefined();
    expect(typeof bobFriend!.since).toBe("string");

    // Sessions: at least the current one.
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);
    expect(typeof body.sessions[0].id).toBe("string");
    expect(typeof body.sessions[0].createdAt).toBe("string");
    expect(typeof body.sessions[0].lastActiveAt).toBe("string");
  });
});
