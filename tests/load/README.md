# Load test — v3 §3.1 capacity + §3.2 performance

Evidence for the spec's non-functional SLOs. Two layers:

## Layer 1 — in-process vitest (always-green gate)

`apps/backend/tests/message-delivery-latency.test.ts` — boots the real
Fastify and Socket.IO stack via `buildApp()`, 1 sender + 4 subscribers, 10
messages, asserts **p95 < 3000ms** on receive latency (spec §3.2 "delivered
within 3 seconds"). Typical in-process: `p50=3ms p95=7ms`. Runs in <1s, runs
in CI.

`apps/backend/tests/presence-io.test.ts::REQ-102` — already asserts **p95 <
2000ms** for presence propagation (spec §3.2 "online status updates should
propagate with latency below 2 seconds").

Run:

```bash
pnpm --filter backend exec vitest run tests/message-delivery-latency.test.ts tests/presence-io.test.ts
```

## Layer 2 — full-scale against docker stack (pre-submission check)

Spec §3.1 numbers — 300 concurrent users, up to 1000 per room — are too heavy
for in-process vitest. The harness at
[`apps/backend/tests/load/message-fanout.ts`](../../apps/backend/tests/load/message-fanout.ts)
ramps N real clients against the docker stack over `socket.io-client` (same
`connectClient` / `subscribe` / `message.new` pattern as the in-process
reference — just scaled out over the Redis-adapter fanout path). Sign-ups,
room create, join, and messages all flow through the public REST + websocket
APIs; nothing touches the DB directly.

```bash
docker compose up --build -d
# wait for backend health
curl -sf http://localhost:4000/health

# Default run — 300 subscribers in one 300-person room, 20 messages.
pnpm --filter backend tsx tests/load/message-fanout.ts

# Stress §3.1's 1000-per-room ceiling:
SUBSCRIBERS=1000 ROOM_SIZE=1000 MESSAGES=10 \
  pnpm --filter backend tsx tests/load/message-fanout.ts

# Fan 300 clients across several smaller rooms:
SUBSCRIBERS=300 ROOM_SIZE=100 MESSAGES=10 \
  pnpm --filter backend tsx tests/load/message-fanout.ts
```

Exit code is 1 if **p95 ≥ 3000ms** (§3.2) or **delivery rate < 99%**. Knobs
(all env-var): `BASE_URL`, `SUBSCRIBERS`, `MESSAGES`, `ROOM_SIZE`,
`RAMP_CONCURRENCY`, `SOCKET_CONCURRENCY`, `SLO_MS`, `MIN_DELIVERY_RATE`,
`SEND_STAGGER_MS`, `RUN_TAG`, `FORWARDED_FOR_BASE`, `ORIGIN`. See the file
header for defaults.

Results from the last full sweep are in [`RESULTS.md`](./RESULTS.md) (300
default, 1000-per-room ceiling, 3×100 fan-out — all PASS, worst p95=25ms).

Targets:

| Spec clause | SLO | Where validated |
| --- | --- | --- |
| §3.1 | 300 concurrent users, 1000/room | `message-fanout.ts` — docker stack |
| §3.2 | message delivery < 3s | in-process vitest (p95) + `message-fanout.ts` |
| §3.2 | presence propagation < 2s | in-process vitest REQ-102 |
| §3.2 | usable at 10,000 messages | docker-stack — load seed + verify pagination/scroll |

The watermark-seq protocol ([ADR-0003](../../docs/adr/0003-watermark-protocol.md))
plus the Redis Socket.IO adapter ([docker-compose.yml](../../docker-compose.yml))
are the architectural underpinnings that let these numbers hold. The in-process
test proves the hot-path itself is fast; horizontal scale is a deployment
concern.
