// REQ-039 + REQ-041 — Socket.IO heartbeat defaults + presence lifecycle.
//
// REQ-039 is a smoke assertion against the engine's heartbeat config. Note:
// spec §6 step 9 names `io.engine.pingInterval` as the public API, but in
// `socket.io@4.8.1` those fields are stored on `io.engine.opts.*` — direct
// properties are `undefined`. Using `opts` is the real Socket.IO v4 surface.
// Defaults: pingInterval 25000ms, pingTimeout 20000ms. This pins them so a
// future drop in `createSocketIO` options surfaces here.
//
// REQ-041 exercises the two-socket online→offline transition. Distinct users
// (alice + bob) sidestep the multi-tab flap discussed in spec §7 bullet
// "Same-user multi-tab presence flap" — one user with two sockets would emit
// "offline" when either socket closes while the other is live, which is a
// known S1 limitation deferred to S2.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { eq } from "drizzle-orm";
import { user } from "@ai-herders/shared/schema";
import type {
  ClientToServerEvents,
  PresenceStateEvent,
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
    .send({ email, username, password: "password1234", name: username })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  return { cookie, userId: await userIdByEmail(email) };
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

function waitForPresence(
  client: TypedClient,
  match: (evt: PresenceStateEvent) => boolean,
  timeoutMs = 2000,
): Promise<PresenceStateEvent> {
  return new Promise<PresenceStateEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("presence.state", handler);
      reject(new Error("timeout waiting for presence.state"));
    }, timeoutMs);
    const handler = (evt: PresenceStateEvent): void => {
      if (!match(evt)) return;
      clearTimeout(timer);
      client.off("presence.state", handler);
      resolve(evt);
    };
    client.on("presence.state", handler);
  });
}

describe("REQ-039 Socket.IO heartbeat defaults", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-039 io.engine exposes pingInterval + pingTimeout defaults", () => {
    // socket.io@4.8.1 stores heartbeat on `engine.opts.*`; the former
    // `engine.pingInterval` shorthand was removed. We type-narrow the probe
    // since the public .d.ts doesn't expose `opts`.
    const opts = (app.io.engine as unknown as {
      opts: { pingInterval?: number; pingTimeout?: number };
    }).opts;
    expect(opts.pingInterval).toBe(25000);
    expect(opts.pingTimeout).toBe(20000);
  });
});

describe("REQ-041 presence online/offline lifecycle", () => {
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

  test("REQ-041 alice observes bob online → offline", async () => {
    const alice = await signUpCookie(app, "pres-a@example.com", "pres_a");
    const bob = await signUpCookie(app, "pres-b@example.com", "pres_b");

    const aliceSocket = await connectClient(baseUrl, alice.cookie);
    try {
      const onlineSeen = waitForPresence(
        aliceSocket,
        (evt) => evt.userId === bob.userId && evt.state === "online",
      );
      const bobSocket = await connectClient(baseUrl, bob.cookie);
      const onlineEvt = await onlineSeen;
      expect(onlineEvt.type).toBe("presence.state");
      expect(typeof onlineEvt.since).toBe("string");
      expect(() => new Date(onlineEvt.since)).not.toThrow();

      const offlineSeen = waitForPresence(
        aliceSocket,
        (evt) => evt.userId === bob.userId && evt.state === "offline",
      );
      bobSocket.close();
      const offlineEvt = await offlineSeen;
      expect(offlineEvt.type).toBe("presence.state");
      expect(offlineEvt.state).toBe("offline");
      expect(typeof offlineEvt.since).toBe("string");
    } finally {
      aliceSocket.close();
    }
  });
});
