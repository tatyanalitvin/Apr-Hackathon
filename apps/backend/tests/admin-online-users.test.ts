// REQ-158 — online-user map is wired to Socket.IO connect/disconnect.
//
// Verifies the cross-module tap: socket-handlers.ts must call
// metrics.recordUserConnect()/recordUserDisconnect() so snapshotMetrics()
// reports the correct distinct-user count.
//
// Multi-tab sanity: a single user with two sockets counts as ONE online
// user (refcount inside the map). This mirrors the rationale in
// socket-presence.test.ts REQ-041 — but note the reversed limitation:
// presence broadcasting is still per-socket, but the admin metric is
// per-distinct-user.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { eq } from "drizzle-orm";
import { user } from "@ai-herders/shared/schema";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@ai-herders/shared/protocol";

import { buildApp } from "../src/app";
import { __resetMetricsForTests, snapshotMetrics } from "../src/lib/metrics";
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

async function waitUntil<T>(
  probe: () => T | undefined,
  timeoutMs = 2000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = probe();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitUntil timed out");
}

describe("REQ-158 admin · online-user map (Socket.IO tap)", () => {
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

  beforeEach(() => {
    __resetMetricsForTests();
  });

  afterEach(() => {
    __resetMetricsForTests();
  });

  test("connect increments, disconnect decrements, multi-tab = 1 user", async () => {
    const alice = await signUpCookie(app, "admin-online-a@example.com", "adm_on_a");
    const bob = await signUpCookie(app, "admin-online-b@example.com", "adm_on_b");
    void alice;
    void bob;

    expect(snapshotMetrics().onlineUsers).toBe(0);

    const aliceSocket = await connectClient(baseUrl, alice.cookie);
    await waitUntil(() =>
      snapshotMetrics().onlineUsers === 1 ? true : undefined,
    );
    expect(snapshotMetrics().onlineUsers).toBe(1);

    const bobTab1 = await connectClient(baseUrl, bob.cookie);
    await waitUntil(() =>
      snapshotMetrics().onlineUsers === 2 ? true : undefined,
    );
    expect(snapshotMetrics().onlineUsers).toBe(2);

    const bobTab2 = await connectClient(baseUrl, bob.cookie);
    // Multi-tab must NOT change distinct-user count. Give the server a
    // couple of ticks to process the extra connect, then re-read.
    await new Promise((r) => setTimeout(r, 100));
    expect(snapshotMetrics().onlineUsers).toBe(2);

    bobTab1.close();
    await new Promise((r) => setTimeout(r, 150));
    // Bob still has tab2 open, so still counted as online.
    expect(snapshotMetrics().onlineUsers).toBe(2);

    bobTab2.close();
    await waitUntil(() =>
      snapshotMetrics().onlineUsers === 1 ? true : undefined,
    );
    expect(snapshotMetrics().onlineUsers).toBe(1);

    aliceSocket.close();
    await waitUntil(() =>
      snapshotMetrics().onlineUsers === 0 ? true : undefined,
    );
    expect(snapshotMetrics().onlineUsers).toBe(0);
  });
});
