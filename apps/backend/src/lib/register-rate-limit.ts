// REQ-009 — /24 CIDR subnet rate limit for POST /api/auth/sign-up/email.
//
// v4 REQ-009 upgrades S1's per-IP signup cap to a /24 subnet bucket so a
// single attacker rotating across 256 IPs in one /24 block (typical for a
// cloud provider allocation or a NAT egress) gets the same 5/hour budget
// as a single static IP. IPv6 collapses to /64 — matches better-auth's
// own normalizeIP default and closes the "each /128 is a free bucket"
// hole.
//
// better-auth 1.6.5 has no per-route keyGenerator hook: the rate-limit
// key is hard-coded `createRateLimitKey(ip, path)` in
// node_modules/better-auth/dist/api/rate-limiter/index.mjs. REQ-009
// therefore runs as a Fastify preHandler BEFORE proxyToBetterAuth.
// better-auth's own per-/32 /sign-up/email customRule stays in auth.ts
// as a belt-and-suspenders cap for a single noisy IP.
//
// Pattern mirrors friend-rate-limit.ts / room-create-rate-limit.ts: lazy
// connect-on-demand client, INCR + EXPIRE-on-first-write for self-
// expiring keys, close-fn for Vitest teardown. flushRedis() in
// tests/setup.ts wipes counters between every test.

import { createClient, type RedisClientType } from "redis";
import { env } from "../env";

export const REGISTER_SUBNET_WINDOW_SECONDS = 60 * 60;
export const REGISTER_SUBNET_LIMIT = 5;

// IPv4 → /24 (drop last octet). IPv6 → /64 (first 4 groups, zero-padded).
// IPv4-mapped IPv6 (::ffff:10.0.1.1) unwraps to IPv4 first. Anything
// unparseable is returned as-is so the limiter still buckets it
// deterministically instead of handing out free passes on weird input.
export function subnetBucket(ip: string): string {
  const unmapped = stripIpv4Mapping(ip);
  const ipv4Parts = unmapped.split(".");
  if (
    ipv4Parts.length === 4 &&
    ipv4Parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  ) {
    return `${ipv4Parts[0]}.${ipv4Parts[1]}.${ipv4Parts[2]}.0/24`;
  }
  if (unmapped.includes(":")) {
    const expanded = expandIPv6(unmapped);
    if (expanded.length === 8) {
      return `${expanded.slice(0, 4).join(":")}::/64`;
    }
  }
  return ip;
}

function stripIpv4Mapping(ip: string): string {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const tail = lower.slice(7);
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) return tail;
  }
  return ip;
}

function expandIPv6(ip: string): string[] {
  if (ip.includes("::")) {
    const [l, r] = ip.split("::");
    const left = l ? l.split(":") : [];
    const right = r ? r.split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return [];
    return [
      ...left,
      ...(Array(missing).fill("0") as string[]),
      ...right,
    ].map((g) => g.padStart(4, "0"));
  }
  const parts = ip.split(":");
  if (parts.length !== 8) return [];
  return parts.map((g) => g.padStart(4, "0"));
}

export interface RateLimitOutcome {
  allowed: boolean;
  retryAfterSec: number;
}

let client: RedisClientType | undefined;

async function getClient(): Promise<RedisClientType> {
  if (!client) {
    const c: RedisClientType = createClient({ url: env.REDIS_URL });
    c.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[register-rate-limit] redis error:", err);
    });
    await c.connect();
    client = c;
  }
  return client;
}

export async function checkRegisterRateLimit(
  ip: string,
): Promise<RateLimitOutcome> {
  const c = await getClient();
  const key = `rate:register-subnet:${subnetBucket(ip)}`;
  const count = await c.incr(key);
  if (count === 1) await c.expire(key, REGISTER_SUBNET_WINDOW_SECONDS);
  if (count <= REGISTER_SUBNET_LIMIT) {
    return { allowed: true, retryAfterSec: 0 };
  }
  const ttl = await c.ttl(key);
  return {
    allowed: false,
    retryAfterSec: ttl > 0 ? ttl : REGISTER_SUBNET_WINDOW_SECONDS,
  };
}

export async function closeRegisterRateLimit(): Promise<void> {
  if (client) {
    await client.quit();
    client = undefined;
  }
}
