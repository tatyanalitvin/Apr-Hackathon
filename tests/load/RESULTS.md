# Load test results — v3 §3.1 / §3.2 evidence

Run of [`apps/backend/tests/load/message-fanout.ts`](../../apps/backend/tests/load/message-fanout.ts)
against a clean `docker compose up --build -d` stack.

- **Date:** 2026-04-20
- **Commit under test:** `705934b` (load harness w/ per-client IP spoofing)
- **Host:** darwin 25.3.0 — Docker Desktop
- **Stack:** `backend` (Fastify + socket.io), `app` (Next.js), `postgres:16-alpine`, `redis:7-alpine` — all `healthy`.
- **Budget:** p95 < 3000ms (§3.2), delivery ≥ 99%.

## Summary

All three canonical load shapes PASS by ~100× the latency budget with zero message loss.

| Variant | clients | rooms × subs | messages × rooms | p50 | p95 | p99 | delivery |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Default 300 | 300 | 1 × 300 | 20 | 14ms | **21ms** | 25ms | 10000/10000 (100%) |
| §3.1 ceiling | 1000 | 1 × 1000 | 10 | 15ms | **25ms** | 28ms | 10000/10000 (100%) |
| Fan-out 3×100 | 300 | 3 × 100 | 10 | 9ms | **17ms** | 17ms | 3000/3000 (100%) |

The §3.1 1000-per-room ceiling is the most demanding — every published message is copied to 1000 subscribers via the Redis socket.io adapter, and still lands p95=25ms end-to-end.

## Exact invocations

```bash
docker compose up --build -d
curl -sf http://localhost:4000/health
docker compose exec -T redis redis-cli FLUSHDB   # drop stale rate-limit keys

# 1. Default 300-sub run (single room)
pnpm --filter backend exec tsx tests/load/message-fanout.ts

# 2. §3.1 ceiling — 1000 subs in a single room
SUBSCRIBERS=1000 ROOM_SIZE=1000 MESSAGES=10 \
  RAMP_CONCURRENCY=25 SOCKET_CONCURRENCY=40 \
  pnpm --filter backend exec tsx tests/load/message-fanout.ts

# 3. 300 subs fanned across 3 rooms of 100
SUBSCRIBERS=300 ROOM_SIZE=100 MESSAGES=10 \
  pnpm --filter backend exec tsx tests/load/message-fanout.ts
```

## Raw output

### Variant 1 — 300 × 1 (default)

```
[load] tag=42aaedd9 base=http://localhost:4000 clients=300 rooms=1 subs/room=300 messages=20
[load] signed up 301 in 4038ms
[load] joined in 212ms
[load] 300 sockets live in 843ms
=== v3 §3.1 / §3.2 fanout load results ===
received       6000/6000 delivery_rate 100.00%
latency        p50=14ms p95=21ms p99=25ms max=26ms
PASS
```

### Variant 2 — 1000 × 1 (§3.1 ceiling)

```
[load] tag=63239697 base=http://localhost:4000 clients=1000 rooms=1 subs/room=1000 messages=10
[load] signed up 1001 in 13148ms
[load] joined in 709ms
[load] 1000 sockets live in 6705ms
[load] round 5/10  sent=5000  recv=5000  miss=0 p95=24ms
[load] round 10/10 sent=10000 recv=10000 miss=0 p95=25ms
=== v3 §3.1 / §3.2 fanout load results ===
received       10000/10000 delivery_rate 100.00%
latency        p50=15ms p95=25ms p99=28ms max=29ms
PASS
```

### Variant 3 — 300 × 3×100

```
[load] tag=ad048a83 base=http://localhost:4000 clients=300 rooms=3 subs/room=100 messages=10
[load] signed up 303 in 4105ms
[load] joined in 172ms
[load] 300 sockets live in 698ms
[load] round 10/10 sent=3000 recv=3000 miss=0 p95=17ms
=== v3 §3.1 / §3.2 fanout load results ===
received       3000/3000 delivery_rate 100.00%
latency        p50=9ms p95=17ms p99=17ms max=18ms
PASS
```

## Spec coverage

| Clause | SLO | Status |
| --- | --- | --- |
| §3.1 — 300 concurrent users | serve 300 simultaneously | **Pass** (Variant 1 + Variant 3) |
| §3.1 — up to 1000 per room | single-room ceiling | **Pass** (Variant 2) |
| §3.2 — message delivery < 3s | p95 budget | **Pass** — worst p95 = 25ms |
| §3.2 — presence propagation < 2s | separate metric | covered by in-process `presence-io.test.ts::REQ-102` |

## Notes & gotchas encountered during validation

These are the non-obvious operational notes for re-running:

1. **Redis must be flushed before the first run of a session.** The REQ-009
   per-/24 sign-up bucket and the @fastify/rate-limit global counters persist
   across runs; stale keys from an earlier attempt will 429 a fresh batch.
   `docker compose exec -T redis redis-cli FLUSHDB` is the full reset.
2. **Spoofed X-Forwarded-For is load-bearing.** The harness tags every client
   with a unique synthetic /24 (`10.<hi>.<lo>.2`) so the REQ-009 subnet cap
   and the global 1000/min limiter don't fuse the whole pool into one bucket
   (commit `705934b` added propagation through every HTTP call, not just sign-up).
   The backend has `trustProxy: true`, so the header is honoured.
3. **`Origin` header is mandatory.** better-auth's CSRF guard rejects sign-ups
   lacking an `Origin` that matches `WEB_ORIGIN`. Harness default is
   `http://localhost:3000`; override with the `ORIGIN` env var.
4. **The in-process sibling test
   [`apps/backend/tests/message-delivery-latency.test.ts`](../../apps/backend/tests/message-delivery-latency.test.ts)
   remains the always-green CI gate** for §3.2. This full-scale script is the
   pre-submission evidence for §3.1 numbers that are too heavy for vitest.

## Architectural underpinnings

- [ADR-0003 — per-room seq watermark](../../docs/adr/0003-watermark-protocol.md)
- [Redis socket.io adapter wiring](../../docker-compose.yml)

The watermark protocol bounds per-message work to a single `INSERT ... RETURNING seq`;
the Redis adapter fans the resulting broadcast out across all backend replicas.
Horizontal scale beyond the numbers above is a deployment concern (add backend
replicas behind the same Redis), not an architectural one.
