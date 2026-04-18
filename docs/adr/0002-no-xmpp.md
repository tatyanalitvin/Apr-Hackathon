# ADR-0002 — No XMPP server at the core; façade optional for S4

**Status**: accepted
**Date**: 2026-04-18 (H+0.5)
**Deciders**: Tatianka, Claude Opus 4.7

## Context

v3.docx hints at federation and the v4 digest lists XMPP compatibility as a credit-boosting bullet. A full XMPP server (ejabberd, Prosody) is a multi-day investment.

## Decision

Build the core chat server over an internal Socket.IO + REST protocol defined in `packages/shared/src/protocol.ts`. **Do not run an XMPP server in S1–S3.** If time allows in S4 (H+40 onward), ship a read-only **XMPP façade** that translates a subset of stanzas to our internal protocol.

## Consequences

+ Core path ships in hours, not days.
+ Watermark + seq allocator + Redis fanout stay native to our stack; no impedance mismatch with XMPP's message routing.
+ If the façade never lands, we still satisfy the brief — XMPP is a credit bullet, not a requirement.
− Judges who grep for "XMPP" see it only in S4 scope doc. Tracked in `docs/FEDERATION.md`.

## Scope

- S1–S3: Socket.IO + REST only.
- S4 (stretch): XMPP façade — `<message/>`, `<presence/>` at minimum. No roster federation.
