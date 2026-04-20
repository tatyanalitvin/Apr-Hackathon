import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-018 (v3.docx §2.2) — "messages remain visible after account removal;
// username is replaced with a placeholder." This test exercises the three
// public serialization paths where a deleted author/peer must render as
// "[deleted user]":
//   1. `GET /api/v1/rooms/:id/messages` — group-room history. The message
//      row's denormalized `authorUsername` is bob's real name (captured at
//      send time); the user.deletedAt flag flips it to "[deleted user]".
//   2. `GET /api/v1/dms` peer identity — `other.username`, `other.name`,
//      `other.deleted`, `frozen`, `frozenReason`.
//   3. `GET /api/v1/dms` `lastMessage.authorUsername` — same substitution as
//      (1) applied via `toMessagePayload`.
//
// The DMs list is the tricky one: the account-delete cascade hard-deletes
// bob's room_member row, so the old inner-join on roomMember → user returns
// zero counterparts for the DM and falls through to the defensive
// `username: ""` branch. The fix resolves the peer via `room.dm_pair_key`
// parse + a direct user JOIN (independent of the cascaded roomMember row).

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { user } from "@ai-herders/shared/schema";
import type {
  DmListItem,
  HistorySliceResponse,
} from "@ai-herders/shared/protocol";

import { buildApp } from "../src/app";
import { DELETED_USER_DISPLAY } from "../src/lib/users";
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

describe("REQ-018 deleted-user display substitution", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-018 group history + DM list + DM lastMessage all render '[deleted user]' for bob after he deletes", async () => {
    const alice = await registerAgent(app, "disp-alice@example.com", "disp_alice");
    const bob = await registerAgent(app, "disp-bob@example.com", "disp_bob");

    // Friendship → bob is eligible as a DM peer.
    await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUserId: bob.userId })
      .expect(201);
    const incoming = await bob.agent
      .get("/api/v1/friends/requests?direction=incoming")
      .expect(200);
    const requestId = incoming.body.requests[0].id as string;
    await bob.agent.post(`/api/v1/friends/requests/${requestId}/accept`).expect(200);

    // Group room created by alice; bob self-joins (public group).
    const roomCreate = await alice.agent
      .post("/api/v1/rooms")
      .send({ name: "disp-room", description: "for display sub test" })
      .expect(201);
    const groupRoomId = roomCreate.body.id as string;
    await bob.agent.post(`/api/v1/rooms/${groupRoomId}/join`).expect(200);

    // Alice + bob each send a message in the group room.
    const aliceGroupBody = "alice-group-msg-before-delete";
    await alice.agent
      .post(`/api/v1/rooms/${groupRoomId}/messages`)
      .send({ body: aliceGroupBody })
      .expect(201);
    const bobGroupBody = "bob-group-msg-before-delete";
    await bob.agent
      .post(`/api/v1/rooms/${groupRoomId}/messages`)
      .send({ body: bobGroupBody })
      .expect(201);

    // DM: bob opens it, then bob posts (so bob is the author of the last DM
    // message — exercises the lastMessage substitution path specifically).
    const dm = await bob.agent
      .post("/api/v1/dms")
      .send({ userId: alice.userId })
      .expect(201);
    const dmRoomId = dm.body.roomId as string;
    const bobDmBody = "bob-dm-msg-before-delete";
    await bob.agent
      .post(`/api/v1/rooms/${dmRoomId}/messages`)
      .send({ body: bobDmBody })
      .expect(201);

    // Bob deletes his account.
    await bob.agent
      .delete("/api/v1/users/me")
      .send({ password: TEST_PASSWORD_OK })
      .expect(204);

    // ── 1. Group-room history: bob's message now renders as [deleted user].
    const histRes = await alice.agent
      .get(`/api/v1/rooms/${groupRoomId}/messages`)
      .expect(200);
    const hist = histRes.body as HistorySliceResponse;
    const bobMsg = hist.messages.find((m) => m.body === bobGroupBody);
    expect(bobMsg).toBeDefined();
    expect(bobMsg!.authorUsername).toBe(DELETED_USER_DISPLAY);
    expect(bobMsg!.authorName).toBe(DELETED_USER_DISPLAY);
    // Alice's own message is still the real name.
    const aliceMsg = hist.messages.find((m) => m.body === aliceGroupBody);
    expect(aliceMsg).toBeDefined();
    expect(aliceMsg!.authorUsername).toBe("disp_alice");

    // ── 2. DMs list: peer resolves to [deleted user] with frozen=user_deleted.
    //     ── 3. lastMessage.authorUsername also substituted.
    const dmsRes = await alice.agent.get("/api/v1/dms").expect(200);
    const dms = dmsRes.body.dms as DmListItem[];
    const thread = dms.find((d) => d.roomId === dmRoomId);
    expect(thread).toBeDefined();
    expect(thread!.other.userId).toBe(bob.userId);
    expect(thread!.other.username).toBe(DELETED_USER_DISPLAY);
    expect(thread!.other.name).toBe(DELETED_USER_DISPLAY);
    expect(thread!.other.deleted).toBe(true);
    expect(thread!.frozen).toBe(true);
    expect(thread!.frozenReason).toBe("user_deleted");
    expect(thread!.lastMessage).not.toBeNull();
    expect(thread!.lastMessage!.body).toBe(bobDmBody);
    expect(thread!.lastMessage!.authorUsername).toBe(DELETED_USER_DISPLAY);
    expect(thread!.lastMessage!.authorName).toBe(DELETED_USER_DISPLAY);
  });
});
