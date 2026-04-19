// v3 §3.2 — "After a user sends a message, it should be delivered to
// recipients within 3 seconds." Scaled-down in-process SLO check: one sender
// plus four subscribers in the same room, 10 messages, measure per-recipient
// receive latency. Asserts p95 < 3000ms. Typical in-process: single-digit ms.
//
// Full-scale 300-user validation lives outside vitest (see
// tests/load/README.md) — this file is the cheap continuous check that
// catches regressions in the hot path (seq allocator + socket.io fanout)
// without the docker round-trip.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { eq } from "drizzle-orm";
import { messageSeq, room, roomMember, user } from "@ai-herders/shared/schema";
import type {
  ClientToServerEvents,
  MessageNewEvent,
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

async function insertPublicGroupRoom(name: string): Promise<string> {
  const id = randomUUID();
  const db = getTestDb();
  await db.insert(room).values({ id, name, kind: "group", visibility: "public" });
  // Seed allocator row so POST /messages doesn't 500 on the first send.
  await db.insert(messageSeq).values({ roomId: id, seq: 0n });
  return id;
}

async function insertMembership(roomId: string, userId: string): Promise<void> {
  await getTestDb()
    .insert(roomMember)
    .values({ id: randomUUID(), roomId, userId });
}

async function subscribe(client: TypedClient, roomId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.emit("room.subscribe", roomId, (res) => {
      if (res.ok) resolve();
      else reject(new Error("room.subscribe refused"));
    });
  });
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

describe("v3 §3.2 message-delivery latency SLO (p95 < 3000ms)", () => {
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

  test("v3 §3.2 fanout latency p95 under 3000ms across 10 msgs × 4 subscribers", async () => {
    const SUBSCRIBERS = 4;
    const MESSAGES = 10;
    const SLO_MS = 3_000;

    const sender = await signUpCookie(app, "slo-sender@example.com", "slo_sender");
    const receivers = await Promise.all(
      Array.from({ length: SUBSCRIBERS }, (_, i) =>
        signUpCookie(app, `slo-rcv-${i}@example.com`, `slo_rcv_${i}`),
      ),
    );

    const roomId = await insertPublicGroupRoom("slo-room");
    await insertMembership(roomId, sender.userId);
    for (const r of receivers) {
      await insertMembership(roomId, r.userId);
    }

    const sockets = await Promise.all(
      receivers.map((r) => connectClient(baseUrl, r.cookie)),
    );
    try {
      await Promise.all(sockets.map((s) => subscribe(s, roomId)));

      const latencies: number[] = [];

      for (let n = 0; n < MESSAGES; n++) {
        const body = `slo-${n}-${randomUUID().slice(0, 8)}`;

        const perRecipient = sockets.map(
          (s) =>
            new Promise<number>((resolve, reject) => {
              const timer = setTimeout(() => {
                s.off("message.new", handler);
                reject(new Error(`timeout waiting for "${body}"`));
              }, SLO_MS * 2);
              const handler = (evt: MessageNewEvent): void => {
                if (evt.roomId !== roomId) return;
                if (evt.message.body !== body) return;
                clearTimeout(timer);
                s.off("message.new", handler);
                resolve(Date.now());
              };
              s.on("message.new", handler);
            }),
        );

        const sentAt = Date.now();
        await request(app.server)
          .post(`/api/v1/rooms/${roomId}/messages`)
          .set("cookie", sender.cookie)
          .send({ body })
          .expect(201);

        const receivedAts = await Promise.all(perRecipient);
        for (const t of receivedAts) {
          latencies.push(t - sentAt);
        }
      }

      const p50 = percentile(latencies, 50);
      const p95 = percentile(latencies, 95);
      const max = Math.max(...latencies);

      // Log so regressions are visible in CI output even when we don't fail.
      // eslint-disable-next-line no-console
      console.log(
        `v3 §3.2 fanout latency — n=${latencies.length} p50=${p50}ms p95=${p95}ms max=${max}ms`,
      );

      expect(p95).toBeLessThan(SLO_MS);
    } finally {
      for (const s of sockets) s.close();
    }
  });
});
