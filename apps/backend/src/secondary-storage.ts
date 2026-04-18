// better-auth `secondaryStorage` adapter backed by Redis.
//
// Used for rate-limit counters (see auth.ts `rateLimit.storage`). Pulls the S3
// "distributed rate-limit storage" item from docs/FOLLOWUPS.md forward:
//   - Counters survive backend restarts and scale across replicas.
//   - Test harness's beforeEach flushRedis() resets all counters between tests,
//     eliminating in-memory module-cache leakage under vitest singleFork.
//
// Connection is a separate Redis client from the Socket.IO pub/sub pair in
// src/socket.ts; mixing subscription state with a plain KV client creates
// subtle bugs (sub clients can't SET). The client lazy-connects on first use
// and stays open for the process lifetime — Node's exit reaps the socket.
//
// Interface matches better-auth 1.6.5's SecondaryStorage contract verified via
// Context7 (2026-04-18):
//   { get: (k) => Promise<unknown>;
//     set: (k, v: string, ttl?: number) => Promise<void>;
//     delete: (k) => Promise<void>; }

import { createClient, type RedisClientType } from "redis";
import { env } from "./env";

let client: RedisClientType | undefined;

async function getClient(): Promise<RedisClientType> {
  if (!client) {
    const c: RedisClientType = createClient({ url: env.REDIS_URL });
    // Swallowing the error event would mask real connection problems;
    // log them and let the next op surface the failure.
    c.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[secondaryStorage] redis error:", err);
    });
    await c.connect();
    client = c;
  }
  return client;
}

export const secondaryStorage = {
  async get(key: string): Promise<string | null> {
    return (await getClient()).get(key);
  },
  async set(key: string, value: string, ttl?: number): Promise<void> {
    const c = await getClient();
    if (typeof ttl === "number" && ttl > 0) {
      await c.set(key, value, { EX: ttl });
    } else {
      await c.set(key, value);
    }
  },
  async delete(key: string): Promise<void> {
    await (await getClient()).del(key);
  },
};
