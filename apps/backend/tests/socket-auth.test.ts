// REQ-038 — Socket.IO handshake authentication.
//
// The subscribe test exercises the happy path for real (cookie → ack ok);
// this file is the focused, small-surface gate for REQ-038. Three cases:
//   1. no cookie  → connect_error (exact contract on the wire)
//   2. garbage cookie → connect_error (better-auth returns no session)
//   3. valid cookie → connect succeeds
//
// Keeping this separate from socket-subscribe.test.ts means the auth gate
// can regress independently and this file pinpoints it.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@ai-herders/shared/protocol";

import { buildApp } from "../src/app";

type TypedClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

async function signUpCookie(
  app: FastifyInstance,
  email: string,
  username: string,
): Promise<string> {
  const res = await request(app.server)
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: "password1234", name: username })
    .expect(200);
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

function openSocket(baseUrl: string, headers?: Record<string, string>): TypedClient {
  return ioClient(baseUrl, {
    transports: ["websocket"],
    reconnection: false,
    ...(headers ? { extraHeaders: headers } : {}),
  });
}

async function expectConnectError(client: TypedClient): Promise<Error> {
  return new Promise<Error>((resolve) => {
    client.once("connect", () => resolve(new Error("unexpected connect")));
    client.once("connect_error", (err) => resolve(err));
  });
}

async function expectConnect(client: TypedClient): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("connect_error", (err) => reject(err));
  });
}

describe("REQ-038 Socket.IO handshake auth", () => {
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

  test("REQ-038 no cookie → connect_error", async () => {
    const client = openSocket(baseUrl);
    const err = await expectConnectError(client);
    client.close();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toBe("unexpected connect");
  });

  test("REQ-038 bogus session cookie → connect_error", async () => {
    // A syntactically well-formed but signature-less session token. Better-auth
    // returns null from getSession; the middleware must reject the handshake.
    const client = openSocket(baseUrl, {
      cookie: "better-auth.session_token=not-a-real-token",
    });
    const err = await expectConnectError(client);
    client.close();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toBe("unexpected connect");
  });

  test("REQ-038 valid cookie → connect succeeds", async () => {
    const cookie = await signUpCookie(app, "ws-auth-ok@example.com", "ws_auth_ok");
    const client = openSocket(baseUrl, { cookie });
    try {
      await expectConnect(client);
      expect(client.connected).toBe(true);
    } finally {
      client.close();
    }
  });
});
