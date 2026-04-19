// R7 (REQ-066) auto-unfreeze. No explicit unfreeze endpoint — the
// predicate is re-evaluated on every send. If the underlying
// friendship + user_block rows flip back to "friends, no block", the
// next send succeeds with 201.
//
// Three phases in one scenario: initially frozen → restore → next send
// ok. Tested for two freeze causes: unfriend, then block.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { friendship, user, userBlock } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

async function register(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<{ agent: request.Agent; userId: string }> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: "password1234", name: username })
    .expect(200);
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return { agent, userId: row.id };
}

async function addFriendship(a: string, b: string): Promise<void> {
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await getTestDb()
    .insert(friendship)
    .values({ id: randomUUID(), userAId, userBId });
}

async function removeFriendship(a: string, b: string): Promise<void> {
  const [userAId, userBId] = a < b ? [a, b] : [b, a];
  await getTestDb()
    .delete(friendship)
    .where(
      and(eq(friendship.userAId, userAId), eq(friendship.userBId, userBId)),
    );
}

async function createDm(
  agent: request.Agent,
  targetId: string,
): Promise<string> {
  const res = await agent.post("/api/v1/dms").send({ userId: targetId });
  return res.body.roomId as string;
}

describe("REQ-066 R7 auto-unfreeze", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-066 R7 unfriend → frozen → re-friend → next send 201", async () => {
    const alice = await register(
      app,
      "unf-re-alice@example.com",
      "unf_re_alice",
    );
    const bob = await register(app, "unf-re-bob@example.com", "unf_re_bob");
    await addFriendship(alice.userId, bob.userId);
    const roomId = await createDm(alice.agent, bob.userId);

    // Phase 1: baseline send works.
    await alice.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "hi" })
      .expect(201);

    // Phase 2: unfriend → next send 409.
    await removeFriendship(alice.userId, bob.userId);
    const frozen = await alice.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "frozen" });
    expect(frozen.status).toBe(409);

    // Phase 3: restore friendship → next send 201. No explicit
    // unfreeze call — the predicate flips on its own.
    await addFriendship(alice.userId, bob.userId);
    const restored = await alice.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "we good now" });
    expect(restored.status).toBe(201);
  });

  test("REQ-066 R7 block → frozen → unblock → next send 201", async () => {
    const alice = await register(
      app,
      "unb-re-alice@example.com",
      "unb_re_alice",
    );
    const bob = await register(app, "unb-re-bob@example.com", "unb_re_bob");
    await addFriendship(alice.userId, bob.userId);
    const roomId = await createDm(alice.agent, bob.userId);

    // Phase 1: baseline.
    await alice.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "ok" })
      .expect(201);

    // Phase 2: bob blocks alice → alice's send 409.
    const blockId = randomUUID();
    await getTestDb().insert(userBlock).values({
      id: blockId,
      byId: bob.userId,
      targetId: alice.userId,
    });
    const frozen = await alice.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "frozen" });
    expect(frozen.status).toBe(409);

    // Phase 3: unblock → next send 201. No unfreeze endpoint needed.
    await getTestDb().delete(userBlock).where(eq(userBlock.id, blockId));
    const restored = await alice.agent
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ body: "unblocked" });
    expect(restored.status).toBe(201);
  });
});
