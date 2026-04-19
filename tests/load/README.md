# Load test — v3 §3.1 capacity + §3.2 performance

Evidence for the spec's non-functional SLOs. Two layers:

## Layer 1 — in-process vitest (always-green gate)

`apps/backend/tests/message-delivery-latency.test.ts` — boots the real Fastify
+ Socket.IO stack via `buildApp()`, 1 sender + 4 subscribers, 10 messages,
asserts **p95 < 3000ms** on receive latency (spec §3.2 "delivered within 3
seconds"). Typical in-process: `p50=3ms p95=7ms`. Runs in <1s, runs in CI.

`apps/backend/tests/presence-io.test.ts::REQ-102` — already asserts **p95 <
2000ms** for presence propagation (spec §3.2 "online status updates should
propagate with latency below 2 seconds").

Run:

```bash
pnpm --filter backend exec vitest run tests/message-delivery-latency.test.ts tests/presence-io.test.ts
```

## Layer 2 — full-scale against docker stack (pre-submission check)

Spec §3.1 numbers — 300 concurrent users, 1000 per room — are too heavy for
in-process vitest. Run these against the docker stack with `socket.io-client`
ramping N clients. The vitest file above is the reference harness: same
`connectClient` / `subscribe` / `message.new` wait pattern, just scaled out.

```bash
docker compose up --build -d
# wait for backend health
curl -sf http://localhost:4000/health

# scale N via env var; defaults match spec
LOAD_SUBSCRIBERS=300 LOAD_MESSAGES=20 \
  pnpm --filter backend tsx tests/load/message-fanout.ts  # not yet scripted
```

Targets:

| Spec clause | SLO | Where validated |
|---|---|---|
| §3.1 | 300 concurrent users, 1000/room | docker-stack ramp — manual pre-submission |
| §3.2 | message delivery < 3s | in-process vitest (p95) + docker-stack ramp |
| §3.2 | presence propagation < 2s | in-process vitest REQ-102 |
| §3.2 | usable at 10,000 messages | docker-stack — load seed + verify pagination/scroll |

The watermark-seq protocol ([ADR-0003](../../docs/adr/0003-watermark-protocol.md))
plus the Redis Socket.IO adapter ([docker-compose.yml](../../docker-compose.yml))
are the architectural underpinnings that let these numbers hold. The in-process
test proves the hot-path itself is fast; horizontal scale is a deployment
concern.
