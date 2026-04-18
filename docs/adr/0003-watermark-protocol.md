# ADR-0003 — Per-room seq watermark + client gap detection

**Status**: accepted
**Date**: 2026-04-18 (H+0.5)
**Deciders**: Tatianka, Claude Opus 4.7

## Context

At 300 concurrent users, Socket.IO broadcasts occasionally drop or reorder across reconnects. The naïve approach (server-authoritative stream, client trusts what it receives) leaks messages on reconnect. Durable per-user queues (classic XMPP / inbox pattern) cost unbounded memory for dormant users (see `memory: project-edge-cases`).

## Decision

- Every room owns a monotonic `seq` column (`message_seq.seq BIGINT`), advanced inside the same transaction as each `INSERT INTO message`.
- Every broadcast carries `{seq, roomHeadSeq}`; clients keep `lastKnownSeq` per room locally.
- If a client sees `roomHeadSeq > lastKnownSeq + 1`, it detects the gap and backfills via `GET /api/v1/rooms/:id/messages?fromSeq=…&toSeq=…`.
- Socket.IO is **transient fanout only**. No durable per-user queue. If a user is offline, they simply gap-detect on reconnect.
- bigint values are serialized as strings on the wire (JSON has no bigint).

## Consequences

+ Dormant users (1yr absence — in-scope per `memory: project-edge-cases`) cost zero memory.
+ Client is authoritative about what it has; server is authoritative about the sequence.
+ Works across multiple backend replicas because `seq` is DB-allocated atomically.
− Every event path must go through the seq allocator. No shortcuts. `CLAUDE.md` non-negotiable #6.
− Client must implement backfill logic. Contract is in `packages/shared/src/protocol.ts` (`MessagePayload`, `HistorySliceResponse`).

## References

- `packages/shared/src/schema.ts` — `message_seq` table + `message.seq` column + unique index on `(roomId, seq)`.
- `packages/shared/src/protocol.ts` — `PROTOCOL_VERSION`, `MessagePayload`, `HistorySliceResponse`.
- `docs/specs/s1-messaging.md` (future) — concrete implementation of the allocator.
