# ADR-0002 — No XMPP federation in MVP

**Status**: accepted
**Date**: 2026-04-18 (H+0.5); refined 2026-04-19 (S4)
**Deciders**: Tatianka, Claude Opus 4.7

## Context

v3.docx §6 lists XMPP federation as a conditional / credit-boosting capability, and the v4 digest repeats it (REQ-180 range). A minimally-honest implementation is not just running Prosody: it requires TLS certificates with SANs on the federation domain, DNS control of `XMPP_DOMAIN`, a peer to federate with, a custom Prosody storage module bridged to our Postgres seq allocator, and an outbound worker translating our internal events to `<message/>` stanzas. Spike estimate: 6–10h of focused work plus infrastructure (certs + DNS) we do not control inside the 52h hackathon window. The submission gate is `docker compose up` from a fresh clone — anything that requires external certs or DNS breaks that gate.

## Decision

Ship the core chat server over an internal Socket.IO + REST protocol defined in `packages/shared/src/protocol.ts`. **Do not run an XMPP server in the MVP.** Ship a deliberate **façade** instead: a judge-visible status page at `/admin/federation` showing "no peers connected" plus `docs/FEDERATION.md` documenting the enable path. Architecture is bridge-ready; implementation is deferred.

## Consequences

+ Core path ships in hours, not days. Watermark + seq allocator + Redis fanout stay native to our stack, with no impedance mismatch against XMPP routing.
+ The submission gate stays green on any clone — no cert, DNS, or peer-domain prerequisites.
+ Protocol shapes (`message.new`, `presence.changed`, etc. in `packages/shared/src/protocol.ts`) are bridge-friendly: a future federation bridge can consume them on the Socket.IO admin namespace and translate to stanzas with no core code changes.
+ The façade makes the scope call visible. Judges reading v3.docx §6 see a status page, an ADR, and a documented plan — not silence.
− MVP does not interoperate with XMPP clients or other XMPP domains.
− Env vars reserved but unused in MVP (`XMPP_DOMAIN`, `XMPP_S2S_PORT`, `XMPP_TLS_CERT`, `XMPP_TLS_KEY`) — harmless but adds reading surface.

**Mitigations.** `docs/FEDERATION.md` captures the full enable path so a post-hackathon contributor can pick it up without re-deriving the design. Env var names are chosen prospectively so the façade matches the eventual integration. The `/admin/federation` page is wired to the same admin gate as `/admin`, so flipping it to a live peer list later is a render change, not a plumbing change.

## Alternatives considered

- **Ship Prosody in docker-compose with no bridge.** Half-integration: the daemon runs but nothing flows through it. Misleading for judges and a submission-gate risk (extra container, extra port, extra failure mode). Rejected.
- **Ignore v3.docx §6 entirely.** Dishonest — judges read the spec and test coverage claims. A silent gap looks worse than a documented scope call. Rejected.
- **Build a real S2S bridge.** 6–10h of work plus infra we do not control. Eats the buffer reserved for submission-gate hardening; demo is single-domain so the work is invisible. Rejected for the MVP; documented as the post-hackathon path in `docs/FEDERATION.md`.

## Scope

- MVP (S1–S4): Socket.IO + REST only. `/admin/federation` façade + documentation.
- Post-hackathon (deferred): Prosody + `mod_s2s` + custom Postgres storage module + outbound bridge. See `docs/FEDERATION.md` for the enable procedure.
