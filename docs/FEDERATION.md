# Federation (XMPP S2S) — Deferred Scope

Status: **not implemented**. Captured here so a post-hackathon contributor can pick it up without re-deriving the design. Referenced by [ADR-0002](adr/0002-no-xmpp.md). Maps to v3.docx §6 (conditional/credit scope).

## What the architecture would look like

A classic XMPP server-to-server (S2S) deployment running **alongside** the existing Socket.IO + Fastify core — not replacing it.

```
┌──────────────────┐         ┌───────────────────┐         ┌──────────────────┐
│  Remote XMPP     │◀──S2S──▶│  Prosody          │◀──SQL──▶│  Postgres        │
│  domain          │  :5269  │  + mod_s2s        │  (ours) │  messages table  │
│  (e.g. chat.foo) │ dialback│  + custom storage │         │  + seq allocator │
└──────────────────┘         └───────────────────┘         └──────────────────┘
                                      ▲
                                      │ loopback bridge (internal REST)
                                      ▼
                             ┌───────────────────┐
                             │  apps/backend     │
                             │  Fastify core     │
                             └───────────────────┘
```

Components:

1. **Prosody** (or ejabberd) bound to `XMPP_DOMAIN` — e.g. `chat.example.com`. Port 5269 open for S2S, 5222 closed (we do not terminate client XMPP — only federate).
2. **mod_s2s + mod_dialback** for peer-domain handshake. TLS cert on `XMPP_DOMAIN` (same Let's Encrypt cert the web uses, SANs: `chat.example.com`, `example.com`).
3. **Custom storage module** — a thin Prosody module that reads/writes our existing `messages` table instead of Prosody's default archive. Keeps the seq allocator as single source of truth; incoming S2S stanzas get a seq like any Socket.IO message.
4. **Identity mapping** — remote JIDs (`alice@peer.org`) land as a dedicated `remote_user` row with a foreign-origin flag. They can only speak in rooms whose `federation_allowed` is true.
5. **Outbound** — when a local message is persisted and the room is federation-enabled, a tiny worker translates it to `<message/>` and hands it to Prosody for S2S delivery.

## Architecture readiness

The core protocol is already bridge-friendly. `packages/shared/src/protocol.ts` defines the event shapes that flow over Socket.IO — `message.new`, `presence.changed`, and the admin-namespace events — with stable fields (room id, sender id, seq, content, timestamps). A federation bridge consumes these on a subscribed Socket.IO client and translates each event into the corresponding XMPP stanza. No core code change is required to attach the bridge; the seq allocator remains the single source of message ordering truth for both local and federated delivery.

Outbound message flow (local user → remote peer):

```text
alice (web)  →  apps/backend (seq +1)  →  Postgres messages
                      │                         │
                      └───> federation bridge <──┘
                                 │ <message/>
                                 ▼
                           Prosody (mod_s2s)
                                 │ :5269 + TLS + dialback
                                 ▼
                           peer.example.org
                                 │
                                 ▼
                            bob@peer.example.org
```

Inbound is the reverse: Prosody receives a `<message/>` from the peer, the custom storage module calls the same `next_seq(room_id)` allocator the Fastify core uses, and the stanza lands in the `messages` table like any Socket.IO-originated message. Clients already subscribed to the room receive it through the normal watermark/fanout path.

## Why we scoped it out

- **Budget.** S4 spec was 8h. Spike estimate for a working Prosody + custom storage + bridge + dialback cert was ~12h — 1.5× the S4 budget, bleeding into buffer reserved for submission-gate hardening.
- **Zero demo impact.** The hackathon demo is a single-domain chat. Judges never see a federated stanza. XMPP is a credit bullet in v3.docx §6, not a gate.
- **Surface area.** Running an XMPP daemon in `docker compose up` adds a second process, a cert, and port 5269 — all of which can break the submission gate for no user-visible payoff.

## How to enable post-hackathon

Prerequisites: own the DNS for `XMPP_DOMAIN`, have a TLS cert with the domain in SANs.

1. Set env vars (both backend and compose):
   - `XMPP_DOMAIN=chat.example.com`
   - `XMPP_S2S_PORT=5269`
   - `XMPP_TLS_CERT=/run/secrets/chat.crt`
   - `XMPP_TLS_KEY=/run/secrets/chat.key`
2. Add the Prosody service to `compose.yaml` (image `prosody/prosody:latest`, volume-mount `infra/prosody/`).
3. Drop in `infra/prosody/prosody.cfg.lua` with `modules_enabled = { "s2s", "dialback", "tls", "our_pg_storage" }` and `storage = "our_pg_storage"`.
4. Implement `infra/prosody/mods/mod_our_pg_storage.lua` — ~200 LOC; read/write `messages` table via libpq. Honour the seq allocator (call the same `next_seq(room_id)` SQL function the backend uses).
5. Flip `federation_allowed = true` on any room that should accept remote peers. Default stays false — federation is opt-in per-room.
6. Add a row to `federation_peers` (domain, dialback status, last-seen) so the `/admin/federation` page can list peers.
7. Test S2S by federating with a second local Prosody (or `xmpp.is`) — exchange `<message/>` both directions, assert seq monotonicity in Postgres.

When `XMPP_DOMAIN` is unset (default), none of the above runs. The admin page shows the empty state. Core chat is unaffected.

## Out of scope even when enabled

- **Client XMPP (C2S, port 5222).** Users stay on our web client. We federate server-to-server only.
- **Roster federation / presence subscriptions across domains.** Too chatty for v1; add later if a peer needs it.
- **MUC-over-XMPP.** Rooms stay ours; federation is per-DM or per-opted-in-room, not XMPP MUC.

## References

- v3.docx §6 — conditional/credit scope for federation.
- ADR-0002 — decision to defer XMPP, keep façade optional.
- RFC 6120 (XMPP Core) — S2S and dialback.
