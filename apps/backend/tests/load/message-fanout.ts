// v3 §3.1 capacity (300 users, up to 1000 per room) + §3.2 performance
// (message delivery p95 < 3 s). Ramps N clients against a running docker
// stack, has each room owner send M messages, measures per-recipient fanout
// latency across the Socket.IO adapter. Exits non-zero if p95 breaks the SLO
// or delivery rate drops below 99%.
//
// The in-process sibling (../message-delivery-latency.test.ts) runs on every
// CI tick at tiny scale; this script is the pre-submission full-scale check.
//
// Run:
//   docker compose up --build -d
//   curl -sf http://localhost:4000/health
//   SUBSCRIBERS=300 MESSAGES=20 pnpm --filter backend tsx tests/load/message-fanout.ts
//
// Knobs (all optional):
//   BASE_URL            default http://localhost:4000
//   SUBSCRIBERS         default 300       (total subscribers across all rooms)
//   MESSAGES            default 20        (messages sent per room)
//   ROOM_SIZE           default 300       (subscribers/room; hard-capped at 1000 per §3.1)
//   RAMP_CONCURRENCY    default 20        (parallel sign-ups / joins per wave)
//   SOCKET_CONCURRENCY  default 30        (parallel websocket opens per wave)
//   RUN_TAG             default random 8-hex (prefixes emails/usernames)
//   SLO_MS              default 3000      (p95 budget, v3 §3.2)
//   MIN_DELIVERY_RATE   default 0.99      (fraction of expected receipts)
//   SEND_STAGGER_MS     default 100       (gap between sends within a round)
//
// Sign-ups send `X-Forwarded-For: 10.<(i>>8)&255>.<i&255>.2` per client so the
// §REQ-009 /24-subnet sign-up cap (5/hour) doesn't trip — each client lands in
// its own /24 bucket. The backend has `trustProxy: true`, so the spoofed
// header wins. Remove or override by setting FORWARDED_FOR_BASE="".

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

const envStr = (k: string, d: string): string => process.env[k] ?? d;
const envInt = (k: string, d: number): number =>
  process.env[k] != null && process.env[k] !== "" ? Number.parseInt(process.env[k]!, 10) : d;
const envNum = (k: string, d: number): number =>
  process.env[k] != null && process.env[k] !== "" ? Number.parseFloat(process.env[k]!) : d;

const BASE_URL = envStr("BASE_URL", "http://localhost:4000");
const SUBSCRIBERS = envInt("SUBSCRIBERS", 300);
const MESSAGES = envInt("MESSAGES", 20);
const ROOM_SIZE = Math.min(envInt("ROOM_SIZE", 300), 1000);
const RAMP_CONCURRENCY = envInt("RAMP_CONCURRENCY", 20);
const SOCKET_CONCURRENCY = envInt("SOCKET_CONCURRENCY", 30);
const RUN_TAG = envStr("RUN_TAG", randomUUID().slice(0, 8));
const SLO_MS = envInt("SLO_MS", 3000);
const MIN_DELIVERY_RATE = envNum("MIN_DELIVERY_RATE", 0.99);
const SEND_STAGGER_MS = envInt("SEND_STAGGER_MS", 100);
// Base octets for the synthetic X-Forwarded-For address; each client gets a
// distinct /24 by indexing the last two octets. "" disables spoofing.
const FORWARDED_FOR_BASE = envStr("FORWARDED_FOR_BASE", "10");
// better-auth blocks sign-up / sign-in without a trusted `Origin` (CSRF
// guard). Docker default is http://localhost:3000; override here when the
// web origin differs.
const ORIGIN = envStr("ORIGIN", "http://localhost:3000");

function spoofedIpFor(index: number): string | null {
  if (!FORWARDED_FOR_BASE) return null;
  const hi = (index >> 8) & 0xff;
  const lo = index & 0xff;
  return `${FORWARDED_FOR_BASE}.${hi}.${lo}.2`;
}

type User = { cookie: string; email: string; username: string; ip: string | null };

type RoomPlan = {
  id: string;
  name: string;
  owner: User;
  subscribers: User[];
  sockets: ClientSocket[];
};

async function inBatches<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const i = nextIdx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Backoff: 200ms, 600ms, 1.8s, 5.4s — mostly to absorb 429s.
      await sleep(200 * Math.pow(3, i));
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${String(lastErr)}`);
}

async function signUp(index: number): Promise<User> {
  const email = `load-${RUN_TAG}-${index}@load.test`;
  const username = `load_${RUN_TAG}_${index}`;
  const spoofedIp = spoofedIpFor(index);
  return withRetry(`signUp[${index}]`, async () => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      origin: ORIGIN,
    };
    if (spoofedIp) headers["x-forwarded-for"] = spoofedIp;
    const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        email,
        username,
        password: "Hackaton_Test_Pw_2026!",
        name: username,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status} ${body.slice(0, 200)}`);
    }
    const setCookies = res.headers.getSetCookie();
    const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    if (!cookie) throw new Error("no Set-Cookie on sign-up");
    return { cookie, email, username, ip: spoofedIp };
  });
}

function authHeaders(user: User, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { cookie: user.cookie, ...extra };
  if (user.ip) h["x-forwarded-for"] = user.ip;
  return h;
}

async function createPublicRoom(owner: User, name: string): Promise<string> {
  return withRetry(`createRoom[${name}]`, async () => {
    const res = await fetch(`${BASE_URL}/api/v1/rooms`, {
      method: "POST",
      headers: authHeaders(owner, { "content-type": "application/json" }),
      body: JSON.stringify({ name, visibility: "public" }),
    });
    if (!res.ok) {
      throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { id: string };
    return body.id;
  });
}

async function joinRoom(user: User, roomId: string): Promise<void> {
  await withRetry(`join[${user.username}]`, async () => {
    const res = await fetch(`${BASE_URL}/api/v1/rooms/${roomId}/join`, {
      method: "POST",
      headers: authHeaders(user),
    });
    // 409 = already a member (idempotent). Any other non-2xx retries.
    if (!res.ok && res.status !== 409) {
      throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  });
}

async function connectSocket(user: User): Promise<ClientSocket> {
  const socket = ioClient(BASE_URL, {
    transports: ["websocket"],
    extraHeaders: { cookie: user.cookie },
    reconnection: false,
    timeout: 20_000,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (err) => reject(err));
  });
  return socket;
}

async function subscribe(socket: ClientSocket, roomId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("subscribe timeout")), 10_000);
    socket.emit(
      "room.subscribe",
      roomId,
      (res: { ok: boolean; error?: string }) => {
        clearTimeout(timer);
        if (res.ok) resolve();
        else reject(new Error(`refused: ${res.error ?? "unknown"}`));
      },
    );
  });
}

async function sendMessage(owner: User, roomId: string, body: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/rooms/${roomId}/messages`, {
    method: "POST",
    headers: authHeaders(owner, { "content-type": "application/json" }),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    throw new Error(`send ${body} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function fmt(n: number): string {
  return Number.isFinite(n) ? `${Math.round(n)}ms` : "n/a";
}

async function main(): Promise<void> {
  const numRooms = Math.max(1, Math.ceil(SUBSCRIBERS / ROOM_SIZE));
  const subsPerRoom = Math.ceil(SUBSCRIBERS / numRooms);
  const totalUsers = numRooms + SUBSCRIBERS;
  console.log(
    `[load] tag=${RUN_TAG} base=${BASE_URL} clients=${SUBSCRIBERS} rooms=${numRooms} subs/room=${subsPerRoom} messages=${MESSAGES}`,
  );

  // Phase 1 — sign up owners + subscribers.
  console.log(`[load] phase 1: signing up ${totalUsers} users (conc=${RAMP_CONCURRENCY})`);
  const signupStart = Date.now();
  const users = await inBatches(
    Array.from({ length: totalUsers }, (_, i) => i),
    RAMP_CONCURRENCY,
    (i) => signUp(i),
  );
  console.log(`[load] signed up ${users.length} in ${Date.now() - signupStart}ms`);

  // Phase 2 — partition into rooms.
  const rooms: RoomPlan[] = [];
  let cursor = 0;
  for (let r = 0; r < numRooms && cursor < users.length; r++) {
    const owner = users[cursor++]!;
    const subs: User[] = [];
    for (let k = 0; k < subsPerRoom && cursor < users.length; k++) {
      subs.push(users[cursor++]!);
    }
    rooms.push({
      id: "",
      name: `load-${RUN_TAG}-${r}`,
      owner,
      subscribers: subs,
      sockets: [],
    });
  }

  // Phase 3 — create public rooms.
  console.log(`[load] phase 2: creating ${rooms.length} public room(s)`);
  for (const plan of rooms) {
    plan.id = await createPublicRoom(plan.owner, plan.name);
  }

  // Phase 4 — join subscribers.
  console.log(`[load] phase 3: joining ${SUBSCRIBERS} subscribers`);
  const joinStart = Date.now();
  for (const plan of rooms) {
    await inBatches(plan.subscribers, RAMP_CONCURRENCY, (u) => joinRoom(u, plan.id));
  }
  console.log(`[load] joined in ${Date.now() - joinStart}ms`);

  // Phase 5 — open sockets + room.subscribe.
  console.log(`[load] phase 4: opening ${SUBSCRIBERS} websockets (conc=${SOCKET_CONCURRENCY})`);
  const sockStart = Date.now();
  for (const plan of rooms) {
    plan.sockets = await inBatches(plan.subscribers, SOCKET_CONCURRENCY, async (u) => {
      const s = await connectSocket(u);
      await subscribe(s, plan.id);
      return s;
    });
  }
  console.log(`[load] ${SUBSCRIBERS} sockets live in ${Date.now() - sockStart}ms`);

  // Graceful teardown on SIGINT so a Ctrl-C mid-test doesn't leak sockets.
  let interrupted = false;
  const onInterrupt = (): void => {
    interrupted = true;
    for (const plan of rooms) {
      for (const s of plan.sockets) s.close();
    }
    process.exit(130);
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);

  // Phase 6 — fanout + latency measurement.
  console.log(
    `[load] phase 5: ${MESSAGES} rounds × ${rooms.length} room(s) — measuring fanout latency`,
  );
  const latencies: number[] = [];
  let sent = 0;
  let received = 0;
  let missed = 0;

  for (let n = 0; n < MESSAGES; n++) {
    if (interrupted) break;
    for (const plan of rooms) {
      const body = `slo-${plan.name}-${n}-${randomUUID().slice(0, 6)}`;

      const perSocketArrival = plan.sockets.map(
        (s) =>
          new Promise<number | null>((resolve) => {
            const timer = setTimeout(() => {
              s.off("message.new", handler);
              resolve(null);
            }, SLO_MS * 3);
            const handler = (evt: {
              roomId: string;
              message?: { body?: string };
            }): void => {
              if (evt.roomId !== plan.id) return;
              if (evt.message?.body !== body) return;
              clearTimeout(timer);
              s.off("message.new", handler);
              resolve(Date.now());
            };
            s.on("message.new", handler);
          }),
      );

      const sentAt = Date.now();
      await sendMessage(plan.owner, plan.id, body);
      sent += plan.sockets.length;

      const arrivals = await Promise.all(perSocketArrival);
      for (const arrivedAt of arrivals) {
        if (arrivedAt == null) {
          missed++;
        } else {
          latencies.push(arrivedAt - sentAt);
          received++;
        }
      }

      if (SEND_STAGGER_MS > 0) await sleep(SEND_STAGGER_MS);
    }
    if ((n + 1) % 5 === 0 || n + 1 === MESSAGES) {
      const so_far_p95 = percentile(latencies, 95);
      console.log(
        `[load] round ${n + 1}/${MESSAGES} sent=${sent} recv=${received} miss=${missed} p95=${fmt(so_far_p95)}`,
      );
    }
  }

  // Teardown.
  for (const plan of rooms) {
    for (const s of plan.sockets) s.close();
  }

  // Report.
  const deliveryRate = sent > 0 ? received / sent : 0;
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const max = latencies.length ? Math.max(...latencies) : NaN;

  console.log("");
  console.log("=== v3 §3.1 / §3.2 fanout load results ===");
  console.log(`clients        ${SUBSCRIBERS} across ${rooms.length} room(s), ${subsPerRoom}/room`);
  console.log(`messages       ${MESSAGES} per room (${MESSAGES * rooms.length} total sends)`);
  console.log(`expected recvs ${sent}`);
  console.log(`received       ${received}`);
  console.log(`missed         ${missed}`);
  console.log(`delivery_rate  ${(deliveryRate * 100).toFixed(2)}%`);
  console.log(`latency        p50=${fmt(p50)} p95=${fmt(p95)} p99=${fmt(p99)} max=${fmt(max)}`);
  console.log(`slo_budget     p95 < ${SLO_MS}ms, delivery ≥ ${(MIN_DELIVERY_RATE * 100).toFixed(0)}%`);
  console.log("");

  const p95Ok = Number.isFinite(p95) && p95 < SLO_MS;
  const deliveryOk = deliveryRate >= MIN_DELIVERY_RATE;
  if (!p95Ok || !deliveryOk) {
    console.error(`FAIL — p95_ok=${p95Ok} delivery_ok=${deliveryOk}`);
    process.exit(1);
  }
  console.log("PASS");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
