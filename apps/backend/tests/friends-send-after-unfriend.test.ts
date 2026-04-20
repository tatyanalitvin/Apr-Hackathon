import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-051 / REQ-059 — resend friend request after unfriend.
// Hotfix: the post-unfriend state leaves friend_request at status='accepted'
// (DELETE /friends/:userId only tears down the friendship row — see R12).
// The duplicate-check branch at POST /friends/requests must consult the
// friendship table before returning 409 already_friends; if the pair is no
// longer friends, the resend is a legitimate new request.
//
// End-to-end shape mirrors the Playwright two-user gate repro so the fix is
// anchored to the same sequence that exposed the bug on feat/s2-friendship-ui
// (commit 97c226f): send → accept → unfriend → resend → expect 201.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { friendRequest, friendship, user } from "@ai-herders/shared/schema";

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

describe("REQ-051/REQ-059 resend friend request after unfriend", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-059 after unfriend: send → accept → DELETE /friends/:id → resend returns 201 pending", async () => {
    const alice = await registerAgent(app, "r051u-alice@example.com", "r051u_alice");
    const bob = await registerAgent(app, "r051u-bob@example.com", "r051u_bob");

    const sendRes = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "r051u_bob" });
    expect(sendRes.status).toBe(201);
    const requestId = sendRes.body.id as string;

    const acceptRes = await bob.agent.post(
      `/api/v1/friends/requests/${requestId}/accept`,
    );
    expect(acceptRes.status).toBe(200);

    const unfriendRes = await alice.agent.delete(
      `/api/v1/friends/${bob.userId}`,
    );
    expect(unfriendRes.status).toBe(204);

    const resendRes = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "r051u_bob" });

    expect(resendRes.status).toBe(201);
    expect(resendRes.body).toMatchObject({ status: "pending" });

    const [row] = await getTestDb()
      .select()
      .from(friendRequest)
      .where(
        and(eq(friendRequest.fromId, alice.userId), eq(friendRequest.toId, bob.userId)),
      );
    expect(row.status).toBe("pending");
    expect(row.respondedAt).toBeNull();
  });

  test("REQ-055 regression: accepted row + friendship row still present → 409 already_friends", async () => {
    const alice = await registerAgent(app, "r051g-alice@example.com", "r051g_alice");
    const bob = await registerAgent(app, "r051g-bob@example.com", "r051g_bob");

    const sendRes = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "r051g_bob" });
    expect(sendRes.status).toBe(201);
    const requestId = sendRes.body.id as string;

    const acceptRes = await bob.agent.post(
      `/api/v1/friends/requests/${requestId}/accept`,
    );
    expect(acceptRes.status).toBe(200);

    const resendRes = await alice.agent
      .post("/api/v1/friends/requests")
      .send({ toUsername: "r051g_bob" });

    expect(resendRes.status).toBe(409);
    expect(resendRes.body).toMatchObject({ error: "already_friends" });

    const [fr] = await getTestDb()
      .select()
      .from(friendRequest)
      .where(
        and(eq(friendRequest.fromId, alice.userId), eq(friendRequest.toId, bob.userId)),
      );
    expect(fr.status).toBe("accepted");

    const [userAId, userBId] =
      alice.userId < bob.userId
        ? [alice.userId, bob.userId]
        : [bob.userId, alice.userId];
    const [fs] = await getTestDb()
      .select()
      .from(friendship)
      .where(and(eq(friendship.userAId, userAId), eq(friendship.userBId, userBId)));
    expect(fs).toBeDefined();
  });
});
