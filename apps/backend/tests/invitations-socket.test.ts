import { TEST_PASSWORD_OK } from "./helpers/fixtures";
// REQ-089 socket fanout — room.invitation.* events.
// Binding: docs/specs/s2-invitations.md §4 R3/R5/R6/R7 + §5 fanout asymmetry.
//
// Covers:
//   R3 — POST /rooms/:id/invitations emits room.invitation.sent to
//        user:{inviteeId} (and nowhere else).
//   R5 — POST /invitations/:id/accept emits room.invitation.accepted to
//        user:{inviterId}.
//   R6 — POST /invitations/:id/decline emits room.invitation.declined to
//        user:{inviterId} (invitee-decline → inviter notified).
//   R7 — DELETE /invitations/:id emits room.invitation.declined to
//        user:{inviteeId} (inviter-cancel → invitee notified). Same event
//        name, inverted audience (binding asymmetry, §5 of spec).

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { eq } from "drizzle-orm";
import { roomMember, user } from "@ai-herders/shared/schema";
import type {
  ClientToServerEvents,
  RoomInvitationAcceptedEvent,
  RoomInvitationDeclinedEvent,
  RoomInvitationSentEvent,
  ServerToClientEvents,
} from "@ai-herders/shared/protocol";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";

type TypedClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

async function userIdByEmail(email: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return row.id;
}

async function signUpCookie(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<{ cookie: string; userId: string }> {
  const res = await request(app.server)
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name: username })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  return { cookie, userId: await userIdByEmail(email) };
}

async function createPrivateRoom(
  app: FastifyInstance,
  ownerCookie: string,
  name: string,
): Promise<string> {
  const res = await request(app.server)
    .post("/api/v1/rooms")
    .set("cookie", ownerCookie)
    .send({ name, visibility: "private" })
    .expect(201);
  return res.body.id as string;
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

function waitForEvent<K extends keyof ServerToClientEvents>(
  client: TypedClient,
  name: K,
  timeoutMs = 2000,
): Promise<Parameters<ServerToClientEvents[K]>[0]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off(name, handler as ServerToClientEvents[K]);
      reject(new Error(`timeout waiting for ${String(name)}`));
    }, timeoutMs);
    const handler = (evt: Parameters<ServerToClientEvents[K]>[0]): void => {
      clearTimeout(timer);
      client.off(name, handler as ServerToClientEvents[K]);
      resolve(evt);
    };
    client.on(name, handler as ServerToClientEvents[K]);
  });
}

async function expectNoEvent<K extends keyof ServerToClientEvents>(
  client: TypedClient,
  name: K,
  windowMs = 250,
): Promise<void> {
  let fired = false;
  const handler = (): void => {
    fired = true;
  };
  client.on(name, handler as ServerToClientEvents[K]);
  await new Promise((r) => setTimeout(r, windowMs));
  client.off(name, handler as ServerToClientEvents[K]);
  if (fired) throw new Error(`unexpected ${String(name)} emission`);
}

describe("REQ-089 Socket.IO fanout for room.invitation.*", () => {
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

  test("REQ-089 R3 room.invitation.sent delivered to user:{inviteeId}", async () => {
    const alice = await signUpCookie(app, "r089s3a@example.com", "r089s3_a");
    const bob = await signUpCookie(app, "r089s3b@example.com", "r089s3_b");
    const roomId = await createPrivateRoom(app, alice.cookie, "Sock R089 S3");

    const bobSocket = await connectClient(baseUrl, bob.cookie);
    try {
      const seen = waitForEvent(bobSocket, "room.invitation.sent");
      const res = await request(app.server)
        .post(`/api/v1/rooms/${roomId}/invitations`)
        .set("cookie", alice.cookie)
        .send({ inviteeUsername: "r089s3_b" })
        .expect(201);
      const evt: RoomInvitationSentEvent = await seen;

      expect(evt.type).toBe("room.invitation.sent");
      expect(evt.invitationId).toBe(res.body.invitationId);
      expect(evt.roomId).toBe(roomId);
      expect(evt.roomName).toBe("Sock R089 S3");
      expect(evt.inviterId).toBe(alice.userId);
      expect(evt.inviterUsername).toBe("r089s3_a");
      expect(typeof evt.createdAt).toBe("string");
      expect(typeof evt.expiresAt).toBe("string");
    } finally {
      bobSocket.close();
    }
  });

  test("REQ-089 R3 room.invitation.sent does NOT leak to non-invitee channels", async () => {
    const alice = await signUpCookie(app, "r089s3x-a@example.com", "r089s3x_a");
    const bob = await signUpCookie(app, "r089s3x-b@example.com", "r089s3x_b");
    const eve = await signUpCookie(app, "r089s3x-e@example.com", "r089s3x_e");
    const roomId = await createPrivateRoom(app, alice.cookie, "Sock R089 S3X");

    const eveSocket = await connectClient(baseUrl, eve.cookie);
    try {
      const silent = expectNoEvent(eveSocket, "room.invitation.sent", 400);
      await request(app.server)
        .post(`/api/v1/rooms/${roomId}/invitations`)
        .set("cookie", alice.cookie)
        .send({ inviteeUsername: "r089s3x_b" })
        .expect(201);
      void bob.userId;
      await silent;
    } finally {
      eveSocket.close();
    }
  });

  test("REQ-089 R5 accept emits room.invitation.accepted to user:{inviterId}", async () => {
    const alice = await signUpCookie(app, "r089s5a@example.com", "r089s5_a");
    const bob = await signUpCookie(app, "r089s5b@example.com", "r089s5_b");
    const roomId = await createPrivateRoom(app, alice.cookie, "Sock R089 S5");
    const send = await request(app.server)
      .post(`/api/v1/rooms/${roomId}/invitations`)
      .set("cookie", alice.cookie)
      .send({ inviteeUsername: "r089s5_b" })
      .expect(201);
    const invitationId = send.body.invitationId as string;

    const aliceSocket = await connectClient(baseUrl, alice.cookie);
    try {
      const seen = waitForEvent(aliceSocket, "room.invitation.accepted");
      await request(app.server)
        .post(`/api/v1/invitations/${invitationId}/accept`)
        .set("cookie", bob.cookie)
        .expect(200);
      const evt: RoomInvitationAcceptedEvent = await seen;

      expect(evt.type).toBe("room.invitation.accepted");
      expect(evt.invitationId).toBe(invitationId);
      expect(evt.roomId).toBe(roomId);
      expect(evt.inviteeId).toBe(bob.userId);
      expect(evt.inviteeUsername).toBe("r089s5_b");
      expect(typeof evt.acceptedAt).toBe("string");
    } finally {
      aliceSocket.close();
    }
  });

  test("REQ-089 R6 decline emits room.invitation.declined to user:{inviterId}", async () => {
    const alice = await signUpCookie(app, "r089s6a@example.com", "r089s6_a");
    const bob = await signUpCookie(app, "r089s6b@example.com", "r089s6_b");
    const roomId = await createPrivateRoom(app, alice.cookie, "Sock R089 S6");
    const send = await request(app.server)
      .post(`/api/v1/rooms/${roomId}/invitations`)
      .set("cookie", alice.cookie)
      .send({ inviteeUsername: "r089s6_b" })
      .expect(201);
    const invitationId = send.body.invitationId as string;

    const aliceSocket = await connectClient(baseUrl, alice.cookie);
    try {
      const seen = waitForEvent(aliceSocket, "room.invitation.declined");
      await request(app.server)
        .post(`/api/v1/invitations/${invitationId}/decline`)
        .set("cookie", bob.cookie)
        .expect(200);
      const evt: RoomInvitationDeclinedEvent = await seen;

      expect(evt.invitationId).toBe(invitationId);
      expect(evt.roomId).toBe(roomId);
      expect(typeof evt.declinedAt).toBe("string");
    } finally {
      aliceSocket.close();
    }
  });

  test("REQ-089 R7 inviter-cancel emits room.invitation.declined to user:{inviteeId} (fanout asymmetry, spec §5)", async () => {
    const alice = await signUpCookie(app, "r089s7a@example.com", "r089s7_a");
    const bob = await signUpCookie(app, "r089s7b@example.com", "r089s7_b");
    const roomId = await createPrivateRoom(app, alice.cookie, "Sock R089 S7");
    const send = await request(app.server)
      .post(`/api/v1/rooms/${roomId}/invitations`)
      .set("cookie", alice.cookie)
      .send({ inviteeUsername: "r089s7_b" })
      .expect(201);
    const invitationId = send.body.invitationId as string;

    const bobSocket = await connectClient(baseUrl, bob.cookie);
    const aliceSocket = await connectClient(baseUrl, alice.cookie);
    try {
      // Inverted audience: invitee hears about the cancel, inviter does not.
      const seenInvitee = waitForEvent(bobSocket, "room.invitation.declined");
      const silentInviter = expectNoEvent(
        aliceSocket,
        "room.invitation.declined",
        400,
      );

      await request(app.server)
        .delete(`/api/v1/invitations/${invitationId}`)
        .set("cookie", alice.cookie)
        .expect(200);

      const evt: RoomInvitationDeclinedEvent = await seenInvitee;
      expect(evt.invitationId).toBe(invitationId);
      expect(evt.roomId).toBe(roomId);
      await silentInviter;
    } finally {
      bobSocket.close();
      aliceSocket.close();
    }
  });

  test("REQ-089 R5 accept also fans out room.member.joined to the room channel", async () => {
    const alice = await signUpCookie(app, "r089s5j-a@example.com", "r089s5j_a");
    const bob = await signUpCookie(app, "r089s5j-b@example.com", "r089s5j_b");
    const roomId = await createPrivateRoom(app, alice.cookie, "Sock R089 S5J");
    const send = await request(app.server)
      .post(`/api/v1/rooms/${roomId}/invitations`)
      .set("cookie", alice.cookie)
      .send({ inviteeUsername: "r089s5j_b" })
      .expect(201);
    const invitationId = send.body.invitationId as string;

    // Alice subscribes to the room channel so the room.member.joined emit
    // lands in her client even before Bob becomes a member.
    const aliceSocket = await connectClient(baseUrl, alice.cookie);
    await new Promise<void>((resolve, reject) => {
      aliceSocket.emit(
        "room.subscribe",
        roomId,
        (ack: { ok: boolean }) => {
          if (ack.ok) resolve();
          else reject(new Error("room.subscribe failed"));
        },
      );
    });

    try {
      const seen = waitForEvent(aliceSocket, "room.member.joined");
      await request(app.server)
        .post(`/api/v1/invitations/${invitationId}/accept`)
        .set("cookie", bob.cookie)
        .expect(200);
      const evt = await seen;

      expect(evt.roomId).toBe(roomId);
      expect(evt.userId).toBe(bob.userId);
      expect(evt.username).toBe("r089s5j_b");

      // Sanity: bob is in fact a member afterwards.
      const [membership] = await getTestDb()
        .select({ id: roomMember.id })
        .from(roomMember)
        .where(eq(roomMember.userId, bob.userId));
      expect(membership).toBeDefined();
      void randomUUID;
    } finally {
      aliceSocket.close();
    }
  });
});
