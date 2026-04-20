import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-201 / REQ-202 — promote (POST /api/v1/rooms/:id/admins/:userId) and
// demote (DELETE /api/v1/rooms/:id/admins/:userId).
// Binding spec: docs/specs/s2-moderation.md §4 REQ-201 + REQ-202 + §6 Task 3.
//
// Owner-only endpoints. Idempotent: promoting an already-admin returns
// {promoted:false}; demoting a plain member returns {demoted:false}. Refusing
// semantics — promoting an owner is 409 {already_owner}, demoting an owner is
// 409 {cannot_demote_owner} — are both tested here because they map onto the
// v3.docx §2.4.7 invariant that "owner cannot lose admin rights" from two
// directions.
//
// Each REAL mutation (member→admin, admin→member) MUST emit `room.role.changed`
// to the room channel. Idempotent no-ops MUST stay silent (same discipline as
// `room.member.joined` in rooms-join-socket-emit.test.ts — re-clicks should not
// produce ghost toasts). A single describe + single buildApp keeps better-auth
// plugin registration from re-racing across app instances.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { and, eq } from "drizzle-orm";
import { roomMember, user } from "@ai-herders/shared/schema";
import type {
  ClientToServerEvents,
  RoomRoleChangedEvent,
  ServerToClientEvents,
} from "@ai-herders/shared/protocol";

import { buildApp } from "../src/app";
import { flushRedis, getTestDb } from "./db-helpers";

type TypedClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

interface SignedUpAgent {
  agent: request.Agent;
  cookie: string;
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
  const res = await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  return { agent, cookie, userId: await userIdByEmail(email) };
}

async function createRoomAsOwner(
  app: FastifyInstance,
  email: string,
  username: string,
  name: string,
): Promise<SignedUpAgent & { roomId: string }> {
  const owner = await registerAgent(app, email, username);
  const res = await owner.agent.post("/api/v1/rooms").send({ name });
  if (res.status !== 201) {
    throw new Error(`failed to create room ${name}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { ...owner, roomId: res.body.id as string };
}

async function joinRoom(target: SignedUpAgent, roomId: string): Promise<void> {
  await target.agent.post(`/api/v1/rooms/${roomId}/join`).expect(200);
}

async function roleOf(roomId: string, userId: string): Promise<string | undefined> {
  const [r] = await getTestDb()
    .select({ role: roomMember.role })
    .from(roomMember)
    .where(and(eq(roomMember.roomId, roomId), eq(roomMember.userId, userId)))
    .limit(1);
  return r?.role;
}

async function connectClient(baseUrl: string, cookie: string): Promise<TypedClient> {
  const client: TypedClient = ioClient(baseUrl, {
    transports: ["websocket"],
    extraHeaders: { cookie },
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("connect_error", (err) => reject(err));
  });
  return client;
}

async function subscribe(client: TypedClient, roomId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.emit("room.subscribe", roomId, (res) => {
      if (res.ok) resolve();
      else reject(new Error(`room.subscribe refused for ${roomId}`));
    });
  });
}

function waitForRoleChanged(
  client: TypedClient,
  timeoutMs = 2000,
): Promise<RoomRoleChangedEvent> {
  return new Promise<RoomRoleChangedEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("room.role.changed", handler);
      reject(new Error("timeout waiting for room.role.changed"));
    }, timeoutMs);
    const handler = (evt: RoomRoleChangedEvent): void => {
      clearTimeout(timer);
      client.off("room.role.changed", handler);
      resolve(evt);
    };
    client.on("room.role.changed", handler);
  });
}

async function expectNoRoleChanged(client: TypedClient, windowMs = 300): Promise<void> {
  let fired = false;
  const handler = (): void => {
    fired = true;
  };
  client.on("room.role.changed", handler);
  await new Promise((r) => setTimeout(r, windowMs));
  client.off("room.role.changed", handler);
  if (fired) throw new Error("unexpected room.role.changed emission");
}

describe("REQ-201 / REQ-202 room moderation promote + demote", () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await flushRedis();
  });

  // ──────────────────────────────────────────────────────────────
  // REQ-201 — POST /api/v1/rooms/:id/admins/:userId
  // ──────────────────────────────────────────────────────────────

  test("REQ-201 no cookie → 401", async () => {
    const res = await request(app.server).post(
      "/api/v1/rooms/00000000-0000-0000-0000-000000000000/admins/00000000-0000-0000-0000-000000000001",
    );
    expect(res.status).toBe(401);
  });

  test("REQ-201 unknown room → 404 room_not_found", async () => {
    const alice = await registerAgent(app, "r201-rnf@example.com", "r201_rnf");
    const res = await alice.agent.post(
      `/api/v1/rooms/00000000-0000-0000-0000-deadbeef0000/admins/${alice.userId}`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "room_not_found" });
  });

  test("REQ-201 caller is not owner → 403 not_owner", async () => {
    const alice = await createRoomAsOwner(app, "r201-no-a@example.com", "r201_no_a", "R201 No");
    const bob = await registerAgent(app, "r201-no-b@example.com", "r201_no_b");
    const carol = await registerAgent(app, "r201-no-c@example.com", "r201_no_c");
    await joinRoom(bob, alice.roomId);
    await joinRoom(carol, alice.roomId);

    const res = await bob.agent.post(`/api/v1/rooms/${alice.roomId}/admins/${carol.userId}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "not_owner" });
    expect(await roleOf(alice.roomId, carol.userId)).toBe("member");
  });

  test("REQ-201 target is not a member → 404 user_not_member", async () => {
    const alice = await createRoomAsOwner(app, "r201-unm-a@example.com", "r201_unm_a", "R201 Unm");
    const stranger = await registerAgent(app, "r201-unm-s@example.com", "r201_unm_s");

    const res = await alice.agent.post(
      `/api/v1/rooms/${alice.roomId}/admins/${stranger.userId}`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "user_not_member" });
  });

  test("REQ-201 target is already owner → 409 already_owner", async () => {
    const alice = await createRoomAsOwner(app, "r201-ao-a@example.com", "r201_ao_a", "R201 Ao");

    const res = await alice.agent.post(`/api/v1/rooms/${alice.roomId}/admins/${alice.userId}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "already_owner" });
    expect(await roleOf(alice.roomId, alice.userId)).toBe("owner");
  });

  test("REQ-201 target is already admin → 200 {promoted:false} idempotent", async () => {
    const alice = await createRoomAsOwner(app, "r201-aa-a@example.com", "r201_aa_a", "R201 Aa");
    const bob = await registerAgent(app, "r201-aa-b@example.com", "r201_aa_b");
    await joinRoom(bob, alice.roomId);

    const first = await alice.agent.post(`/api/v1/rooms/${alice.roomId}/admins/${bob.userId}`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ promoted: true, role: "admin" });

    const second = await alice.agent.post(`/api/v1/rooms/${alice.roomId}/admins/${bob.userId}`);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ promoted: false, role: "admin" });
    expect(await roleOf(alice.roomId, bob.userId)).toBe("admin");
  });

  test("REQ-201 member → admin: 200 {promoted:true} + role row updated", async () => {
    const alice = await createRoomAsOwner(app, "r201-ok-a@example.com", "r201_ok_a", "R201 Ok");
    const bob = await registerAgent(app, "r201-ok-b@example.com", "r201_ok_b");
    await joinRoom(bob, alice.roomId);
    expect(await roleOf(alice.roomId, bob.userId)).toBe("member");

    const res = await alice.agent.post(`/api/v1/rooms/${alice.roomId}/admins/${bob.userId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ promoted: true, role: "admin" });
    expect(await roleOf(alice.roomId, bob.userId)).toBe("admin");
  });

  test("REQ-201 + REQ-207 promote emits room.role.changed to room subscribers", async () => {
    const alice = await createRoomAsOwner(app, "r201-sock-a@example.com", "r201_sock_a", "R201 Sock");
    const bob = await registerAgent(app, "r201-sock-b@example.com", "r201_sock_b");
    await joinRoom(bob, alice.roomId);

    const bobSocket = await connectClient(baseUrl, bob.cookie);
    try {
      await subscribe(bobSocket, alice.roomId);
      const seen = waitForRoleChanged(bobSocket);

      const res = await alice.agent.post(`/api/v1/rooms/${alice.roomId}/admins/${bob.userId}`);
      expect(res.status).toBe(200);

      const evt = await seen;
      expect(evt.type).toBe("room.role.changed");
      expect(evt.roomId).toBe(alice.roomId);
      expect(evt.userId).toBe(bob.userId);
      expect(evt.role).toBe("admin");
      expect(evt.changedBy).toBe(alice.userId);
      expect(typeof evt.changedAt).toBe("string");
      expect(() => new Date(evt.changedAt)).not.toThrow();
    } finally {
      bobSocket.close();
    }
  });

  test("REQ-201 idempotent repeat does NOT emit", async () => {
    const alice = await createRoomAsOwner(app, "r201-idem-a@example.com", "r201_idem_a", "R201 Idem");
    const bob = await registerAgent(app, "r201-idem-b@example.com", "r201_idem_b");
    await joinRoom(bob, alice.roomId);

    const bobSocket = await connectClient(baseUrl, bob.cookie);
    try {
      await subscribe(bobSocket, alice.roomId);
      const seen = waitForRoleChanged(bobSocket);
      await alice.agent
        .post(`/api/v1/rooms/${alice.roomId}/admins/${bob.userId}`)
        .expect(200);
      await seen;

      const silent = expectNoRoleChanged(bobSocket, 300);
      const repeat = await alice.agent.post(
        `/api/v1/rooms/${alice.roomId}/admins/${bob.userId}`,
      );
      expect(repeat.status).toBe(200);
      expect(repeat.body).toMatchObject({ promoted: false });
      await silent;
    } finally {
      bobSocket.close();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // REQ-202 — DELETE /api/v1/rooms/:id/admins/:userId
  // ──────────────────────────────────────────────────────────────

  test("REQ-202 no cookie → 401", async () => {
    const res = await request(app.server).delete(
      "/api/v1/rooms/00000000-0000-0000-0000-000000000000/admins/00000000-0000-0000-0000-000000000001",
    );
    expect(res.status).toBe(401);
  });

  test("REQ-202 unknown room → 404 room_not_found", async () => {
    const alice = await registerAgent(app, "r202-rnf@example.com", "r202_rnf");
    const res = await alice.agent.delete(
      `/api/v1/rooms/00000000-0000-0000-0000-deadbeef0000/admins/${alice.userId}`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "room_not_found" });
  });

  test("REQ-202 caller is not owner → 403 not_owner", async () => {
    const alice = await createRoomAsOwner(app, "r202-no-a@example.com", "r202_no_a", "R202 No");
    const bob = await registerAgent(app, "r202-no-b@example.com", "r202_no_b");
    const carol = await registerAgent(app, "r202-no-c@example.com", "r202_no_c");
    await joinRoom(bob, alice.roomId);
    await joinRoom(carol, alice.roomId);
    await alice.agent
      .post(`/api/v1/rooms/${alice.roomId}/admins/${carol.userId}`)
      .expect(200);

    const res = await bob.agent.delete(`/api/v1/rooms/${alice.roomId}/admins/${carol.userId}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "not_owner" });
    expect(await roleOf(alice.roomId, carol.userId)).toBe("admin");
  });

  test("REQ-202 target is not a member → 404 user_not_member", async () => {
    const alice = await createRoomAsOwner(app, "r202-unm-a@example.com", "r202_unm_a", "R202 Unm");
    const stranger = await registerAgent(app, "r202-unm-s@example.com", "r202_unm_s");

    const res = await alice.agent.delete(
      `/api/v1/rooms/${alice.roomId}/admins/${stranger.userId}`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "user_not_member" });
  });

  test("REQ-202 demoting the owner → 409 cannot_demote_owner", async () => {
    const alice = await createRoomAsOwner(app, "r202-o-a@example.com", "r202_o_a", "R202 Owner");

    const res = await alice.agent.delete(`/api/v1/rooms/${alice.roomId}/admins/${alice.userId}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "cannot_demote_owner" });
    expect(await roleOf(alice.roomId, alice.userId)).toBe("owner");
  });

  test("REQ-202 target is plain member → 200 {demoted:false} idempotent", async () => {
    const alice = await createRoomAsOwner(app, "r202-pm-a@example.com", "r202_pm_a", "R202 Pm");
    const bob = await registerAgent(app, "r202-pm-b@example.com", "r202_pm_b");
    await joinRoom(bob, alice.roomId);

    const res = await alice.agent.delete(`/api/v1/rooms/${alice.roomId}/admins/${bob.userId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ demoted: false, role: "member" });
    expect(await roleOf(alice.roomId, bob.userId)).toBe("member");
  });

  test("REQ-202 admin → member: 200 {demoted:true} + role row updated + socket emit", async () => {
    const alice = await createRoomAsOwner(app, "r202-ok-a@example.com", "r202_ok_a", "R202 Ok");
    const bob = await registerAgent(app, "r202-ok-b@example.com", "r202_ok_b");
    const carol = await registerAgent(app, "r202-ok-c@example.com", "r202_ok_c");
    await joinRoom(bob, alice.roomId);
    await joinRoom(carol, alice.roomId);
    await alice.agent
      .post(`/api/v1/rooms/${alice.roomId}/admins/${bob.userId}`)
      .expect(200);
    expect(await roleOf(alice.roomId, bob.userId)).toBe("admin");

    const carolSocket = await connectClient(baseUrl, carol.cookie);
    try {
      await subscribe(carolSocket, alice.roomId);
      const seen = waitForRoleChanged(carolSocket);

      const res = await alice.agent.delete(
        `/api/v1/rooms/${alice.roomId}/admins/${bob.userId}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ demoted: true, role: "member" });

      const evt = await seen;
      expect(evt.type).toBe("room.role.changed");
      expect(evt.roomId).toBe(alice.roomId);
      expect(evt.userId).toBe(bob.userId);
      expect(evt.role).toBe("member");
      expect(evt.changedBy).toBe(alice.userId);
      expect(typeof evt.changedAt).toBe("string");

      expect(await roleOf(alice.roomId, bob.userId)).toBe("member");
    } finally {
      carolSocket.close();
    }
  });

  test("REQ-202 idempotent (plain member) does NOT emit", async () => {
    const alice = await createRoomAsOwner(app, "r202-idem-a@example.com", "r202_idem_a", "R202 Idem");
    const bob = await registerAgent(app, "r202-idem-b@example.com", "r202_idem_b");
    const carol = await registerAgent(app, "r202-idem-c@example.com", "r202_idem_c");
    await joinRoom(bob, alice.roomId);
    await joinRoom(carol, alice.roomId);

    const carolSocket = await connectClient(baseUrl, carol.cookie);
    try {
      await subscribe(carolSocket, alice.roomId);

      const silent = expectNoRoleChanged(carolSocket, 300);
      const res = await alice.agent.delete(
        `/api/v1/rooms/${alice.roomId}/admins/${bob.userId}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ demoted: false });
      await silent;
    } finally {
      carolSocket.close();
    }
  });
});
