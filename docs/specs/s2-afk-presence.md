# Spec: S2 — AFK Presence (three-state: online / afk / offline, multi-tab merged)

**Status**: draft (2026-04-18)
**Branch**: `feat/s2-afk-presence` (worktree to be created off `main` after S1 merge)
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code — S2 presence agent
**Scope**: REQ-099 … REQ-105 (three-state presence, 1-min AFK threshold, multi-tab merge rules, propagation SLO, block-aware presence). Extends the S1 binary presence (`REQ-041`) into the three-state model without breaking S1 subscribers.

**REQ-ID assignment** (resolves collision with `s2-friendship.md:24,61` which assigns REQ-105 = "B appears offline to A"):

| ID | Meaning (this spec) |
| --- | --- |
| REQ-099 | Three states exist on the wire and in the registry |
| REQ-100 | AFK rule — 1-minute client-detected idle threshold, `presence.set` on transition |
| REQ-101 | Multi-tab — any tab online → merged online |
| REQ-102 | Multi-tab — all tabs afk → merged afk |
| REQ-103 | Multi-tab — all tabs closed/dead → merged offline |
| REQ-104 | Propagation SLO < 2 s, covers initial panel load via REST (no socket race on first render) |
| REQ-105 | **Block-aware presence** — blocker sees blockee as `offline`; symmetric for the blockee (REQ-073 effect 6). Per `s2-friendship.md` R17, this is implemented HERE, not there. |

The REST endpoint `GET /api/v1/presence` falls under REQ-104 (same reason we test propagation at all — the panel has to show a coherent state when it first renders). Not a separate REQ.

## 1. Why

BRIEF.md demo step 5 is "alice opens a second tab and goes AFK; bob's member panel shows alice turn from green to yellow within 2 seconds". This one bullet drags in every interesting edge case of multi-tab presence: the second tab means a naive "per-socket presence" breaks (we'd flap online↔offline on every tab switch), the 1-minute threshold means client-side idle detection (server can't observe "user moved mouse in tab A"), and the "<2s" SLO in v3.docx §2.7.2 / §3.2 sets the propagation budget. Getting this wrong turns the 5-second demo moment into a confusing flicker.

S1 already ships a presence skeleton: [packages/shared/src/protocol.ts:12](../../packages/shared/src/protocol.ts#L12) defines `PresenceState = "online" | "afk" | "offline"`, [protocol.ts:55](../../packages/shared/src/protocol.ts#L55) defines the `presence.state` event, and [protocol.ts:83](../../packages/shared/src/protocol.ts#L83) defines `presence.set` (client→server) accepting `Exclude<PresenceState, "offline">` (i.e. `"online" | "afk"`). What S1 does NOT ship is the server-side logic that merges multiple sockets into one per-user state — S1 emits on every connect/disconnect, which the `s1-chat.md` R12 note explicitly flags as "two tabs for the same user will flap". This spec replaces that naive fanout with a per-user presence registry.

The protocol contract from S1 is already right — we do NOT want to change the event shape. That means S1 clients can read S2 events without modification. Our job is the server: (a) track each user's sockets + their client-reported AFK status, (b) compute the per-user state from that, (c) fanout only on state transitions (not every socket change), (d) do it correctly under horizontal scale (the Redis adapter is already wired, but presence registry needs its own Redis keys — see §5).

## 2. Non-goals

Explicit, so reviewers don't flag:

- **New presence states beyond online/afk/offline** (no `busy`, `dnd`, no custom status messages) — v3.docx §2.2.1 is exhaustive.
- **Per-room presence scoping** — v3.docx §2.2 is global; alice appearing online is alice appearing online in every member panel. The S1 "Q2 follow-up" about scoping presence to room co-members is out of scope here (still flagged in §8 Q2); it's an optimization, not a requirement. This spec stays with the S1 global-emit model.
- **Last-seen-at / "alice was online 5 min ago" hint in the UI** — not in v3.docx. Offline users show as offline; how long they've been offline is not a surface.
- **Typing indicator** — `typing` / `typing.start` / `typing.stop` events exist in [protocol.ts:62](../../packages/shared/src/protocol.ts#L62) + [protocol.ts:84-85](../../packages/shared/src/protocol.ts#L84) but are owned by the `s2-typing.md` soft-scope spec. This spec does not implement those events; however, they share the same Redis presence registry design (both are per-user transient) — flagged in §7 as a reuse opportunity.
- **Push notifications on presence change** — native browser notifications are not in v3.docx; the member panel updates in place.
- **Cross-device presence for mobile clients** — hackathon is web-only. If a future spec adds mobile, the per-user registry design here already handles it (a phone is just another socket; the merge logic doesn't care about device type).
- **Replay of missed presence events on reconnect** — presence is transient; on reconnect, the client reads the current state from the initial "room member panel" REST call + subscribes to live updates. No per-user event log.
- **Dormant-user GC** — REQ-125 handles soft-deleted users; this spec doesn't special-case them because presence for soft-deleted users is always `offline` (no sockets) by definition.
- **Database persistence of presence state** — presence is Redis-only transient state. No table. Survives process restart only if Redis survives (it does; there's a `redisdata` docker volume at [docker-compose.yml:36](../../docker-compose.yml#L36) — but we explicitly treat "all processes down simultaneously" as "everyone offline", which is correct).

## 3. User stories

- As Alice (one tab, actively clicking), I appear as `online` to bob; my presence is emitted within the same tick my socket finishes the handshake. (REQ-099, REQ-104)
- As Alice, when I don't interact with the tab for 60 seconds, my browser emits `presence.set("afk")`; the server fans out `presence.state` to bob with `state: "afk"` within 2s of the emit. Bob's member panel dot changes from green to yellow. (REQ-100, REQ-104)
- As Alice, when I move the mouse / type / click in the tab after being AFK, my browser emits `presence.set("online")`; the server fans out `state: "online"`. (REQ-100)
- As Alice with two tabs (Tab A active, Tab B idle for 5 minutes), I appear as `online` — the active tab wins. Bob never sees me as AFK. (REQ-101)
- As Alice with two tabs both idle >1 min, I appear as `afk`. Both tabs have emitted `presence.set("afk")`; the merged state is `afk`. (REQ-102)
- As Alice closing my last tab (or the browser crashing), my socket disconnects; my per-user presence becomes `offline`; the event fans out within 2s. (REQ-103, REQ-104)
- As Alice with two tabs and I close one, I stay `online` (or `afk`, whatever the remaining tab says). Bob doesn't see a flap. (REQ-101, REQ-103)
- As Bob subscribing to the room, on initial load I get the current presence state for each member via a REST endpoint (not an event replay) — see §5. After that, live updates arrive as `presence.state` events. The client ordering rule (§5 "REST-vs-socket race") ensures I never miss a transition that happened between the REST snapshot and my subscription. (REQ-099, REQ-104)
- As Alice, when bob blocks me via `POST /api/v1/users/:id/block` (owned by `s2-friendship.md` R16), bob's sockets immediately see me as `offline` and my sockets see bob as `offline` — regardless of whether either of us is actually connected. Unblock restores the real state. (REQ-105)
- As the demo operator, the member panel reflects alice's transitions to AFK and back consistent with the 1-min threshold, and reconnecting bob's browser doesn't show stale state. (REQ-099, REQ-104)

## 4. Requirements (testable)

`pnpm trace` greps `tests/` for each REQ-ID; test names MUST embed them verbatim.

- [ ] **R1 (REQ-099 three states)**: `PresenceState` ([protocol.ts:12](../../packages/shared/src/protocol.ts#L12)) is already `"online" | "afk" | "offline"`. No wire-format change. The `presence.state` event ([protocol.ts:55](../../packages/shared/src/protocol.ts#L55)) carries `{ type, userId, state, since }` as-is from S1. Test asserts a server emits each of the three values correctly across the transitions in R2-R5.
- [ ] **R2 (REQ-099 initial state on connect)**: When the first socket for a user finishes handshake, the server (a) adds the socket to the per-user registry (§5), (b) if the user was previously offline (registry was empty), emits `presence.state` with `state: "online"`, `since: now()`; (c) if the user was already online (a second tab joining), does NOT emit (suppression rule). Test: distinct-user observer watches user B connect → one `online` event. Then B opens a second tab → observer sees NO additional event.
- [ ] **R3 (REQ-100 AFK via presence.set)**: Client emits `presence.set("afk")` → server (a) updates the socket's tab-local state to AFK, (b) recomputes the user's merged state from all sockets, (c) if the merged state changed (online → afk), emits `presence.state { state: "afk", since: now() }`. If the merged state didn't change (e.g. another tab is still online), NO emit. Test: two tabs, both go AFK; observer sees ONE `afk` event (on the second tab's set, when the merged state flips), not two.
- [ ] **R4 (REQ-100 return from AFK)**: Client emits `presence.set("online")` → recompute + fanout on transition. Test: alice goes afk → online; observer sees `afk` then `online`.
- [ ] **R5 (REQ-101 multi-tab union — any active = online)**: Two tabs, Tab A online + Tab B afk → merged state `online`. Test: observer sees `online` after the first `set("online")` on A; B's `set("afk")` triggers NO further fanout. The merge function: `state = sockets.some(s => s.tab === "online") ? "online" : sockets.some(s => s.tab === "afk") ? "afk" : "offline"`. Test exercises each branch with exact socket counts (1-online+1-afk, 2-afk, 0-sockets).
- [ ] **R6 (REQ-102 all tabs afk → afk)**: Two tabs both reporting afk → merged state `afk`. Covered by R5's branch but called out separately for REQ-102 trace: test name literal contains `REQ-102` (same pattern as s1-chat.md R2's two-ID test).
- [ ] **R7 (REQ-103 last tab closed → offline)**: Disconnect handler removes the socket from the registry; if registry is empty for that user, emit `presence.state { state: "offline", since: now() }`. If other sockets remain, DO recompute merged state (closing a tab that was the only "online" source may flip merged `online` → `afk`). Test: Tab A online + Tab B afk → close A → observer sees `afk` (merged flip). Close B → observer sees `offline`.
- [ ] **R8 (REQ-103 abrupt disconnect + refresh-debounce)**: Crash / network drop / page refresh triggers the Socket.IO `disconnect` handler; Socket.IO's `connectionStateRecovery` ([socket.ts:29](../../apps/backend/src/socket.ts#L29)) only buffers missed events — the disconnect handler still fires on transport drop and a fresh connect fires a new `connect`. Without care, a plain F5 flaps online → offline → online in ~100 ms. **Design: deferred-HDEL with a 3 s grace.** On `disconnect`, schedule `setTimeout(3000, () => HDEL-and-maybe-emit)`. On `connect`, cancel any pending timer keyed on the same userId if the reconnecting socket's userId matches. Merge-state recomputation still happens on the connect (the new socket HSETs its entry); if the grace timer fires because the user didn't reconnect in time, the HDEL-and-emit path runs. 3 s is a tunable constant (`PRESENCE_GRACE_MS`) — large enough to absorb typical page refresh (100–800 ms) and transport hiccups, small enough that a real browser close still produces offline within the REQ-104 2 s window (with the 3 s grace, SLO becomes ~5 s for offline only; flagged in §7). Tests: (a) force-disconnect + immediate reconnect → no offline event fires (timer cancelled); (b) force-disconnect and stay disconnected → offline event fires at ~3 s; (c) timing under the REQ-104 SLO for the ONLINE and AFK transitions (those have no grace — instant emit).
- [ ] **R9 (REQ-104 propagation SLO <2s)**: From the moment the server receives `presence.set("afk")` (or the first connect, or the last disconnect) to the moment the event is delivered to a subscribed observer socket, wall-clock latency MUST be ≤2000 ms at the 95th percentile in a single-backend-process test. Test: 50 trials of alice-set-afk → measure observer receive time; assert p95 < 2000 ms (expected typical: <50 ms). Production SLO monitoring is out of scope (S3).
- [ ] **R10 (REQ-104 server-pushed initial state via REST)**: `GET /api/v1/presence?userIds=a,b,c,…` returns `{ states: Array<{ userId, state, since }> }` for up to 100 user IDs per call. States computed from the per-user Redis registry (pipelined GETs against `presence:snapshot:<userId>` + `presence:since:<userId>`). Missing user (no registry key) → `state: "offline", since: null`. Called by the frontend once per room-member-panel load; after that, live updates arrive via sockets. **Client ordering rule** (§5 "REST-vs-socket race"): client MUST subscribe to presence events BEFORE issuing the REST call and MUST merge any events that arrive during the in-flight REST by preferring the socket event when its `since > REST-snapshot.since`. This contract is a frontend implementation detail; the spec requires the backend to provide `since` precisely enough for that comparison to work. Test: mix of online/afk/offline users, assert each row matches registry.
- [ ] **R11 (REQ-104 auth on REST + sockets)**: `GET /api/v1/presence` and `presence.set` both require a valid better-auth session. REST: missing cookie → 401. Socket: missing session was already checked on connect (S1 R9). `presence.set` has NO per-call auth check beyond the socket-already-authed baseline — the socket's bound userId is trusted. Test: socket bound as alice cannot emit `presence.set` pretending to be bob (the event payload doesn't even have a userId — the server reads `socket.data.userId`; spoofing impossible by design).
- [ ] **R12 (global fanout semantics)**: `presence.state` is emitted via `io.emit` (global fanout, same as S1). Per §8 Q2, S2 stays with global emit; scoping by room-co-membership is S3 follow-up. Test: observer subscribed only to an unrelated room still receives alice's transitions (documents the current behavior; this test is updated to a negative assertion when Q2 flips to scoped). **Block-aware filter (R16) does NOT scope fanout — it overlays per-recipient `offline` spoofing on top of the global emit**; see R16.
- [ ] **R13 (Redis registry shape — matches §5)**: Per-user key `presence:user:<userId>` is a HASH mapping `<serverId>:<socketId>` → `"online" | "afk"` (§5 for rationale on the serverId-scoped field). Computation of merged state = `HGETALL` + apply the R5 reducer. Belt-and-suspenders TTL: every write refreshes `EXPIRE presence:user:<userId> 300` (5 min); a server that dies without HDEL leaves entries that Redis reaps within 5 min even if the boot-purge (R14) didn't catch them (e.g. a rogue process that never rebooted). Snapshot key `presence:snapshot:<userId>` and companion `presence:since:<userId>` share the same 5 min refresh. Alternative shape flagged in §8 Q3.
- [ ] **R14 (boot-time registry purge — serverId source defined)**: At backend boot, the `presence.ts` module computes `const SERVER_ID = crypto.randomUUID()` once at import time and keeps it in module scope. All HSETs use `<SERVER_ID>:<socketId>` as the hash field. Boot purge iterates all `presence:user:*` keys (SCAN, not KEYS — cheap at our cardinality), and for each key HDELs any fields whose prefix matches a STALE server id. "Stale" = not the current SERVER_ID AND not the id of any other live backend instance (discovered via a small `presence:servers` Redis SET that each instance SADDs its SERVER_ID into at boot + SREMs at graceful shutdown + TTL-refreshes). First-boot with no prior instances → no-op purge but still SADDs current id. Alternative: hostname+pid (Q5). Test: seed Redis with entries for a fake `<old-server-id>:<socket-id>` that's not in `presence:servers`; start a backend; assert those entries are HDELed, entries for other live server ids are untouched.
- [ ] **R15 (transverse: socket auth still enforced)**: The presence.set handler receives the socket's bound userId from the handshake auth (S1 R9); no additional session check per event. Missing session on socket → connection already rejected. Test is transitive from S1's REQ-038 test; no duplicate coverage.
- [ ] **R16 (REQ-105 block-aware presence)**: When `presence.state` would be emitted for subject S, recipients R where `user_block(byId=R, targetId=S)` OR `user_block(byId=S, targetId=R)` exists MUST see S as `offline`. Symmetric: S must see R as `offline` too, which is handled by R's own transitions running through this same filter. Implementation: emit primary event with `io.except(blockedUserRooms).emit(...)` where every socket has joined `user:<userId>` on handshake (contract with `s2-friendship.md` R11's existing `user:<userId>` room pattern). Then, for each uid in `blockedUserIds` (both directions), ``io.to(`user:${uid}`).emit("presence.state", { ...evt, state: "offline" })``. Lookup: one Redis or DB read per emit — `user_block WHERE byId=S OR targetId=S`. At 300 concurrent users the block list is expected to be O(1..10) per user; the cost is negligible. Block/unblock events (owned by `s2-friendship.md` R16/R18) MUST trigger a `presence.state` re-emit for the affected pair so the UI re-syncs — contract item documented there; this spec provides the "emit offline-or-real for a pair" helper `presence.emitForPair(a, b)` that friendship spec calls. Test: (a) alice online, bob blocks alice; bob receives `alice=offline`, carol (unrelated) receives `alice=online`; (b) alice offline, bob blocks alice; already offline, no-op; (c) alice online, bob unblocks alice; bob receives `alice=online`.

## 5. Design notes

### Client-side idle detection (out of scope implementation, in scope contract)

The 1-minute threshold (REQ-100) is detected **in the browser**, not the server. The server can't see mouse movement in a tab; asking "how long has this socket been idle" is the wrong question because a socket may be fully subscribed yet the user went to get coffee. The frontend owns:

- A per-tab idle timer, reset on `mousemove` / `keydown` / `click` / `touchstart` / `visibilitychange` (when page visible).
- On timer reaching 60s → emit `presence.set("afk")`.
- On any resume event after AFK → emit `presence.set("online")`.
- On page unload / tab close → socket naturally disconnects (Socket.IO fires `disconnect`).

This spec stipulates the contract the frontend must honor (v3.docx §2.2.2 "more than 1 minute"). The frontend implementation lives in `s2-web.md`. Backend test harness uses direct socket emits to simulate the frontend.

### Per-user presence registry

Redis key pattern: `presence:user:<userId>` → HASH mapping `<SERVER_ID>:<socketId>` → `"online" | "afk"`, plus two companion keys:

- `presence:snapshot:<userId>` → string ∈ `{"online","afk","offline"}` — the last merged state we broadcast; used for O(1) change detection without reducing the full hash.
- `presence:since:<userId>` → ISO timestamp string — wall-clock of the transition INTO the current snapshot state. Written in the same pipelined `MULTI/EXEC` (or pipeline) as the snapshot SET. Deleted when snapshot transitions to `"offline"` → absence is re-created on the next online/afk write. REST (R10) returns `since: null` when the key is missing.

**SERVER_ID source** (R14): `apps/backend/src/lib/presence.ts` computes `export const SERVER_ID = crypto.randomUUID()` once at module load. The value is stable for the process lifetime; a restart generates a new id. Alternative considered: `\`${os.hostname()}:${process.pid}\`` — rejected because `pid` reuse across restarts is possible on long-lived hosts and would defeat the boot-purge. A `presence:servers` Redis SET tracks which SERVER_IDs are live; each backend SADDs on boot, SREMs on graceful shutdown, and SETs a 30 s TTL refreshed on every presence write (pragmatic heartbeat; if a process dies, its SERVER_ID falls out of the SET within 30 s and the next boot-purge sweeps its residue).

**Belt-and-suspenders HASH TTL**: every mutation (HSET / HDEL) also calls `EXPIRE presence:user:<userId> 300` (5 min). If a process dies without cleanup AND the boot-purge somehow misses (e.g. Redis restart loses `presence:servers`), the entry still disappears within 5 min. Active users refresh the TTL constantly (every transition), so live data never reaps.

Why Redis not in-process memory: the backend already has a Redis adapter wired ([socket.ts:38](../../apps/backend/src/socket.ts#L38)) for Socket.IO fanout. If the deploy ever scales to 2+ backend processes (S3 horizontal scale), each process only sees its local sockets; a cross-process presence calculation needs shared state. Redis is that shared state. For S2's single-process deploy, the Redis calls are cheap (<1 ms local) and the code is already scale-ready.

Why a HASH not a SET or bitmap: the per-socket *tab state* is part of the value, not just presence/absence. `HGETALL presence:user:<userId>` returns every socket's tab state in one round-trip; the reducer runs in-process. Cardinality: at most `tabs_per_user × 1` entries per user; we expect ≤ 5 at the demo scale.

Why serverId in the hash field: boot-time purge (R14). Without it, a backend crash + restart leaves orphan entries claiming the user is still connected to this process, and there's no way to distinguish them from entries owned by still-live peer processes during S3 horizontal scale.

### HSET + snapshot sequence — atomicity note

The write sequence (HSET → HGETALL → compute → SET snapshot/since → emit) is NOT wrapped in a Lua script or `MULTI/EXEC`. Two processes racing to broadcast the same transition produce two identical `presence.state` events; clients handling the second as a same-state update is harmless (snapshot+since match → UI no-op). Explicit: **this spec accepts double-emit on rare races; readers should not expect linearizability.** If S3 load-testing flags the double-emits, wrap in a Lua script (§8 Q7) — one-line upgrade, no protocol change.

### State transitions — precise semantics

On **socket connect** (after better-auth verification, S1 R9):
1. `HSET presence:user:<userId> <serverId>:<socketId> "online"` (new sockets start online; the client may immediately follow with `presence.set("afk")` if the tab is already idle).
2. Read the hash, compute merged state.
3. If the merged state changed from the previous snapshot → emit `presence.state`. Keep the previous snapshot in Redis too (key `presence:snapshot:<userId>` → string state) for O(1) change detection without replaying the full hash.
4. `SET presence:snapshot:<userId> <newState>`.

On **`presence.set(<state>)` event** (socket-bound userId):
1. `HSET presence:user:<userId> <serverId>:<socketId> <state>` (`<state>` ∈ `{"online","afk"}`).
2. Steps 2-4 same as connect.

On **socket disconnect**:
1. `HDEL presence:user:<userId> <serverId>:<socketId>`.
2. If the hash is now empty → `DEL presence:user:<userId>`, `SET presence:snapshot:<userId> "offline"`, emit `presence.state { state: "offline" }`.
3. If the hash has entries → recompute merged state, compare to snapshot, emit on change.

Every emit uses `io.emit("presence.state", evt)` (global fanout; Q2 revisits). `since` field is `new Date().toISOString()` at the moment the server decides to emit.

### The "snapshot" key — why it matters

Without a snapshot, emit-on-change requires us to know the pre-mutation state. We could compute both pre and post by reading the hash twice, but that's racy (another process may mutate between reads). The snapshot is a single-writer cache of "what did we last tell the world"; combined with the Redis adapter pubsub, only one process broadcasts any transition. Races where two processes try to broadcast the same transition simultaneously result in two identical `presence.state` events — harmless for clients (the state is already where it needs to be), and the double-emit is bounded to rare transition moments.

### REST endpoint for initial member-panel load

`GET /api/v1/presence?userIds=a,b,c` — query string of comma-separated ids, capped at 100 per call (enforced via zod, §8 Q4). Handler pipelines `GET presence:snapshot:<userId>` per id; defaults missing → `"offline"`. Response shape: `{ states: Array<{ userId, state, since }> }`. `since` comes from a companion key `presence:since:<userId>` (string ISO timestamp written alongside every snapshot SET) — or NULL for users who have never connected. The companion-key approach avoids fattening the snapshot value with a JSON payload; two pipelined GETs are fine.

**Why not a socket event?** A room-member-panel load is a synchronous REST query in the existing pattern (membership list is REST; we add presence to its response in the future or alongside — decided by `s2-web.md`). Streaming initial state over sockets adds complexity (race between "subscribe" and "initial state" messages). REST-then-subscribe is the clean model.

### REST-vs-socket race — client ordering rule

Between the client issuing `GET /api/v1/presence?userIds=…` and the REST response landing, a subject's state may transition and be broadcast via `presence.state`. If the client applies the REST response AFTER it has processed the socket event, the REST answer (stale) overwrites the fresh socket update. The ordering rule clients MUST honor (specified here; enforced in frontend code per `s2-web.md`):

1. Socket subscription MUST be established before the REST call is issued.
2. Socket events received during the in-flight REST call are buffered by the client.
3. On REST response arrival, the client reduces: for each userId in the response, if a buffered socket event exists whose `since` is strictly greater than the REST row's `since`, prefer the socket event's state. Null `since` (never-connected) is treated as minimal.
4. After reduction, replay any remaining buffered events in order.

The backend's contract supporting this rule: `since` on the REST row is the exact timestamp written to `presence:since:<userId>` at the moment the current snapshot was set (§5 per-user registry). `since` on the `presence.state` event is the same wall-clock moment that snapshot+since were written. So "socket-event-since > REST-row-since" is a reliable "this event is newer".

### Socket.IO surface

**No new events.** We reuse:
- `"presence.state"` (server → client) — existing, see [protocol.ts:76](../../packages/shared/src/protocol.ts#L76).
- `"presence.set"` (client → server) — existing, see [protocol.ts:83](../../packages/shared/src/protocol.ts#L83).

**One new REST endpoint**: `GET /api/v1/presence`.

**No new DB tables or columns.** Presence is Redis-only transient.

### Interaction with S1's binary emit

S1 ships the global flap at [apps/backend/src/socket-handlers.ts:46-49](../../apps/backend/src/socket-handlers.ts#L46-L49) — `io.emit("presence.state", …online)` on connect, `io.emit("presence.state", …offline)` on disconnect, with no merge. S2 replaces that code path: the new emit path lives in `apps/backend/src/lib/presence.ts` and is gated by transitions in the merged state, not raw socket events. The existing `presenceEvent` helper at [socket-handlers.ts:34-41](../../apps/backend/src/socket-handlers.ts#L34-L41) is reused (or inlined — implementer's call). The S1 R12 test ("two-distinct-user setup: observer watches subject connect → online; B disconnects → offline") still passes against the S2 implementation — that scenario has one tab per user, where every socket event IS a transition. The S1 limitation note about "two tabs for the same user will flap" becomes an R2/R3 assertion ("no flap") in S2.

### Block-aware fanout (REQ-105)

R16 requires that a blocker and a blockee see each other as `offline`. Implementation layers on top of the global emit:

1. Every socket joins `\`user:${userId}\`` on handshake (contract with `s2-friendship.md` R11's existing pattern — socket room shared with friend-request-accepted events).
2. On `presence.state` emit for subject S, look up `user_block` rows where `byId = S OR targetId = S`. Build the recipient block set as `blockedUids = union of rows' byIds and targetIds minus S`.
3. Emit the real event with `io.except(blockedUids.map(uid => \`user:${uid}\`)).emit("presence.state", evt)`.
4. For each uid in `blockedUids`, emit the spoofed offline event targeted at that user's sockets only.

Cost per transition: one DB query (small — user_block is O(1..10) per user at 300-scale). Cached? Not in S2; cheap to add a per-user "who-blocks-me" set in Redis if profiling flags it. The query is indexed — `user_block_by_target_uq` and `user_block_target_idx` ([schema.ts:304-305](../../packages/shared/src/schema.ts#L304-L305)).

Block/unblock mutations (`s2-friendship.md` R16/R18) call this spec's `presence.emitForPair(a, b)` helper to re-broadcast the current state for both sides, because the block's effect on what a sees of b and vice versa only propagates when someone emits. Contract item documented there; helper exported from `apps/backend/src/lib/presence.ts`.

### `since` semantics

The `since` field ([protocol.ts:59](../../packages/shared/src/protocol.ts#L59)) is the timestamp of the MOST RECENT TRANSITION into the current state, NOT the timestamp of the last tab-level change. Example: alice connects at T0 → `online since T0`. Tab goes afk at T0+90s, flips merged state → `afk since T0+90s`. Tab back to online at T0+120s → `online since T0+120s`. If alice's afk event didn't flip merged state (another tab still online), `since` doesn't update because the state didn't change. Rationale: clients showing "alice has been afk for X seconds" get a meaningful X. Documented so frontends can render a "since 10:45" tooltip if they want (out of scope, just reserving the contract).

### Horizontal scale — the short version

At 300 concurrent users across 2–3 backend processes (S3 hypothetical), the presence registry Redis keys are shared; every process can compute every user's merged state from `HGETALL`. Emits use `io.emit` which the Redis adapter fans out across processes (already configured). The snapshot key + the serverId-scoped hash field mean no process double-emits a transition another process already broadcast. S2 stays single-process but the design doesn't reshape when S3 scales out.

## 6. Tasks (each <2h, R-numbers map to §4)

Note: all backend routes + socket handlers live in `apps/backend/` (**Fastify** + Socket.IO), NOT in `apps/web/src/app/api/` (Next.js). The existing presence flap at `apps/backend/src/socket-handlers.ts:46-49` is what this spec replaces — do not add a Next.js route handler.

1. [ ] **Presence registry module** — `apps/backend/src/lib/presence.ts`. Module-level `export const SERVER_ID = crypto.randomUUID()` at import time; `presence:servers` SADD at boot, SREM at graceful shutdown, 30 s TTL refresh on every write. Pure Redis helpers: `addSocket(userId, socketId, state)`, `removeSocket(userId, socketId)`, `setSocketState(userId, socketId, state)`, `computeMergedState(userId)`, `getSnapshot(userId)`, `setSnapshot(userId, state)`, `emitForPair(a, b)` (for block/unblock re-emit). Every write refreshes the 5-min HASH TTL (R13). Unit tests (no socket, direct Redis): R5 reducer branches (3-socket permutations), boot-time purge (R14), TTL refresh.
2. [ ] **Socket.IO wiring (R2, R7)** — replace the global flap at [socket-handlers.ts:46-49](../../apps/backend/src/socket-handlers.ts#L46-L49). Connect handler → `addSocket` + `socket.join(\`user:${userId}\`)` + maybe-emit. Disconnect handler uses the R8 grace-timer path (see task 3). Integration test via two socket clients (observer + subject), distinct users, covers S1 R12 parity.
3. [ ] **Disconnect grace-timer (R8)** — `apps/backend/src/lib/presence.ts` exports a `scheduleOfflineSweep(userId, socketId)` helper that sets `setTimeout(PRESENCE_GRACE_MS, () => HDEL + maybe-emit)`. Connect handler cancels any pending timer for the same userId before HSET. Tests: (a) disconnect + immediate reconnect (same userId, new socketId) → no offline event; (b) disconnect + wait > 3 s → offline event fires once.
4. [ ] **presence.set handler (R3, R4)** — Socket.IO event handler. Read `socket.data.userId` (set during handshake auth — S1 R9); call `setSocketState`; maybe-emit. Test: afk-online-afk sequence, assert exactly the right sequence of observer events.
5. [ ] **Multi-tab merge (R5, R6)** — integration. Two sockets per subject (simulating two tabs). Walk through the R5 branch matrix: (online, afk) → online, (afk, afk) → afk, (online, online) → online, closing one online tab leaving one afk → afk. No flap on second-tab events that don't change merged state.
6. [ ] **Snapshot + emit-on-change (implicit across R2-R7)** — `presence.ts` tests. Snapshot key + since key written every transition; read on next compute; no emit when state unchanged. Test a same-state `presence.set("online")` on an already-online user: no emit, snapshot unchanged, since unchanged.
7. [ ] **Last-tab disconnect → offline (R7, R8)** — covered by R7 integration test; add abrupt-disconnect branch + grace-timer assertions. Also assert `since` timestamp freshness (within 1s of test wall clock).
8. [ ] **Propagation latency (R9)** — `presence-latency.test.ts`. 50-trial loop: subject emits `presence.set("afk")`, observer records receive time; assert p95 under 2000 ms. Local timings will be <50 ms; the test is there as a regression guard. The 3 s offline-grace is excluded from this measurement — only ONLINE and AFK transitions must meet 2 s.
9. [ ] **REST `GET /api/v1/presence` (R10, R11)** — `apps/backend/src/routes/presence.ts` (**Fastify route**; registered via `app.register` under `/api/v1`). Mixed fixture (3 online, 2 afk, 2 offline, 1 never-connected); assert returned array matches registry. Unauth → 401.
10. [ ] **Zod validation on query (R10, §8 Q4)** — `presenceQuerySchema = z.object({ userIds: z.string().transform(s => s.split(",")).pipe(z.array(z.string()).min(1).max(100)) })`. Boundary tests: 100 ids → 200; 101 → 400.
11. [ ] **Global emit semantics (R12)** — `presence-fanout.test.ts`. Observer subscribed to an unrelated room receives subject's state changes. Documents current scope; when Q2 flips, this test is rewritten to the negative assertion.
12. [ ] **Block-aware presence (R16)** — `presence-block-aware.test.ts`. Fixture: alice/bob/carol, alice online. Bob POST `/api/v1/users/:id/block` targeting alice (friendship spec endpoint). Assertions: bob's socket receives `alice=offline` (via presence.emitForPair from the block handler); carol's socket receives `alice=online`; alice's own sockets receive `bob=offline`. Unblock restores real state. Note: depends on `s2-friendship.md` R16/R18 calling this spec's `emitForPair` — contract item documented there.
13. [ ] **Boot-time purge (R14)** — `presence-boot-purge.test.ts`. Seed Redis with entries for a fake old SERVER_ID that's NOT in `presence:servers`; start a backend; assert those entries are HDELed. Seed entries for a second, still-live SERVER_ID (SADDed to `presence:servers`); assert those entries are untouched.
14. [ ] **S1 parity test still passes** — run S1's REQ-041 test against the S2 implementation. Two-distinct-user observer/subject connect → `online`, disconnect → `offline`. No code change expected; belt-and-suspenders.
15. [ ] **Gate dry-run** — Manual: open alice in two tabs; bob in a third. Bob sees alice `online`. Let alice's first tab idle 70s → bob sees `online` (other tab active). Let alice's second tab also idle 70s → bob sees `afk` within 2s of the second set. Click in tab 1 → `online`. F5-refresh alice's tab 1 → NO flap (grace timer absorbs). Close both alice tabs → `offline` within ~3s. Bob blocks alice → alice sees `bob=offline`; unblock → real state back.

## 7. Out of scope / follow-ups

- **Room-scoped presence fanout (Q2)** — optimization to reduce fanout volume at scale. Not needed for 300-user demo scale (at worst, 300² = 90k events per full-mesh transition round, but real-world transitions are sparse and the Redis adapter's pub/sub is cheap).
- **Typing indicator reusing the presence registry** — `s2-typing.md` soft-scope spec will want a per-user transient signal too; share the `presence.ts` module's "per-user hash in Redis" pattern. No common helper yet; extract when typing lands.
- **Last-seen / "online 5 min ago"** — not in v3.docx.
- **Mobile / desktop client distinction in presence** — not needed.
- **Persistent presence history for analytics** — S3+ ops concern.
- **Presence visible to banned / non-friends with explicit "hide"** — not in v3.docx §2.2 or §2.3. If S3 adds a "hide presence from X" privacy toggle, the fanout decision moves from "global" to "per-recipient-filtered"; design doesn't fundamentally change but adds a per-event filter.
- **REST endpoint for bulk room presence** — e.g. `GET /api/v1/rooms/:id/presence` returning all member states. More ergonomic than the comma-separated userIds query but adds a second endpoint. Defer until `s2-web.md` says the member-panel wants it.
- **S1 R12 obsolescence flag** — after this spec lands, `s1-chat.md` R12's "same-user multi-tab test is testing S2" note becomes false (S2 owns it now); update s1-chat.md to point to this spec's R5 as the definitive test.
- **`presence.set("offline")` explicit** — protocol already excludes `"offline"` from the client-side state union ([protocol.ts:83](../../packages/shared/src/protocol.ts#L83)). Offline is server-inferred only. Keep it that way.

## 8. Open questions

Gating groups:

- **Blocks nothing critical — scope confirmations**: Q1 (deferred idle detection to frontend — consultation only), Q2 (global vs scoped fanout — one-line flip), Q6 (threshold config — frontend-only), Q7 (Lua linearizability — S3-defer).
- **Blocks task 1 (registry shape + SERVER_ID source)**: Q3 (HASH vs. two keys — default HASH per R13), Q5 (SERVER_ID source — default UUID per R14).
- **Blocks task 9 (REST handler body)**: Q8 (per-caller block filter in REST — must be wired in R10's handler per option (a)).
- **Blocks task 10 (REST dto)**: Q4 (presenceQuerySchema dto — minor).

- [ ] **Q1 — Client-side idle detection in the frontend.** This spec stipulates the frontend MUST implement a 60-second idle timer and emit `presence.set`. That's a contract with `s2-web.md`, not a backend change. Flag: confirm `s2-web.md` owner accepts this. Alternative: server-side "time since last event from this socket" heuristic — rejected because Socket.IO heartbeats refresh that metric regardless of user activity, so it doesn't match "user has been idle".
- [ ] **Q2 — Global vs room-scoped `presence.state` fanout.** Current design: `io.emit` (global). Alternative: emit only to rooms the subject is a member of (needs per-user membership query on every transition; Redis set per user of their room IDs maintained on join/leave). Tradeoffs:
    - **(a) Global**: simple; every client sees every transition; fanout volume = |users|² at worst, sparse in practice.
    - **(b) Scoped**: fanout = sum over subject's rooms of room size. Correct scaling characteristic. Adds a per-transition DB/Redis hit.
    - **Recommendation**: **(a) for S2**. At 300 users, (a)'s fanout is cheap; the complexity of (b) is S3's job. One-line flip from `io.emit` to `socket.rooms.forEach(r => io.to(r).emit(...))`-equivalent when S3 needs it.
- [ ] **Q3 — Presence registry shape: HASH per user (R13) vs. key-per-socket.** Alternative design: `SET presence:socket:<socketId> "<userId>:<state>"`; on read, `KEYS presence:socket:*` + filter client-side. Rejected (KEYS is O(N)); included to document that we considered it. HASH is correct.
- [ ] **Q4 — Zod dto for `GET /api/v1/presence`.** `presenceQuerySchema = z.object({ userIds: z.string().transform(s => s.split(",")).pipe(z.array(z.string().min(1)).min(1).max(100)) })`. Requires approval for new dto (CLAUDE.md #5). Minimal; should clear approval quickly. Alternative: POST `/api/v1/presence/query` with a JSON body — ergonomically heavier for a read operation, rejected.
- [ ] **Q5 — Emit `presence.state` to the subject's OWN sockets.** Default: yes (global fanout sends to every socket, including the subject's own). That means alice's Tab A sees a `presence.state` event for alice when alice herself transitions. Frontend can ignore `evt.userId === me.id`. Alternative: filter server-side to skip subject's own sockets. Rejected — simplicity wins; filtering adds a per-emit branch with negligible savings.
- [ ] **Q6 — AFK threshold configurability.** v3.docx §2.2.2 says "more than 1 minute". Should the threshold be a constant in frontend code (hardcoded 60_000 ms) or env-configurable? Recommendation: hardcoded in the frontend. Changing it needs code, not env; env-config is over-engineering for a single literal. This is a frontend Q; backend never sees the threshold because AFK is client-reported.
- [ ] **Q7 — Atomicity of the HSET+snapshot sequence.** Default design (R13 + §5 "atomicity note") accepts double-emit on rare races. Alternative: wrap the HSET + compute + snapshot-SET + since-SET in a Lua script so the merged-state transition is linearizable. Lua script is ~20 lines and doesn't change the protocol. Recommendation: **defer**. The double-emit is a no-op at the client (identical snapshot+since → UI no-op); Lua adds test-harness complexity. Flip if S3 load testing flags spurious UI churn.
- [ ] **Q8 — Emit offline on block even if the blocker isn't online to receive it.** R16 spec says "emit offline to blocker's sockets". If the blocker has no sockets, the emit is a no-op — and that's correct because on their next connect, the REST panel load (R10) will query presence for their contacts and the snapshot already reflects the real state (not filtered). That means a newly-connecting blocker would see their blockee's REAL state (e.g. `online`), which VIOLATES REQ-105. Options:
    - **(a)** REST handler (R10) accepts an authenticated caller and applies the block filter per-row against that caller's `user_block` rows. The raw snapshot is real; the per-caller filter lies. This is the correct shape. Recommendation.
    - **(b)** Store filtered snapshots per-pair. Combinatorial blow-up; rejected.
    - **Decision**: go with (a) — one JOIN in the REST handler. Adds a bullet to R10 but no shape change. This Q marks the gap; R10 body should be edited to reflect (a) when implementing.

**Contract gaps spotted (informational):**

- S1's `s1-chat.md` R12 note about two-tabs-flapping ("If someone writes a same-user multi-tab test against this spec, they're testing S2 behavior") should be struck or updated when this spec lands. Not a blocker.
- Socket.IO's `connectionStateRecovery` preserves the socket-id across the recovery window; this spec depends on that ID stability for R8 (registry entries survive the blip). If the recovery config changes in S3, R8 breaks. Test covers the common path; a config change would be caught by CI.
- `socket.data.userId` is set during the handshake auth (S1 R9); this spec assumes that contract. No new dependency.

## 9. Gate criteria

Self-check before declaring "S2 AFK presence done":

- [ ] `pnpm --filter backend test:run` green — all presence tests pass
- [ ] `pnpm trace` covers REQ-099, REQ-100, REQ-101, REQ-102, REQ-103, REQ-104, REQ-105
- [ ] Manual (demo step 5): alice's two tabs + bob watching — full AFK → online → offline cycle visible with <2s propagation
- [ ] No flap when alice opens/closes a second tab while the first stays active
- [ ] No flap on plain F5 refresh (grace timer absorbs the disconnect/reconnect pair)
- [ ] Initial room-member-panel load returns correct presence states for all listed users via `GET /api/v1/presence`
- [ ] p95 latency test under 2000 ms for ONLINE/AFK transitions (expected <50 ms single-process local); offline excluded (3 s grace)
- [ ] Boot-time purge reliably clears only this server's orphan entries
- [ ] Bob blocks alice → bob's UI shows alice offline within 2 s; carol's UI still shows alice online; unblock restores
- [ ] S1 REQ-041 test still passes (regression guard)

Timebox: S2 soft gate at H+16 (2026-04-18 24:00 UTC). AFK is the 5th demo step; if R9 propagation flakes on slow CI, ship with a lowered p95 assertion (e.g. 5000 ms) rather than skipping the test — demo works live regardless. If the Redis-backed registry causes issues at S2 scale (unlikely), fall back to an in-process `Map<userId, Map<socketId, state>>` for S2 single-process deploy and re-introduce Redis in S3.

## 10. Acceptance test outline (REQ → test mapping)

| REQ-ID | How exercised | Layer |
| --- | --- | --- |
| REQ-099 | Connect → `online` event; disconnect → `offline`; `presence.set("afk")` → `afk`. Three-state coverage. | integration (Socket.IO) |
| REQ-100 | Client emits `presence.set("afk")` → observer sees `afk`; `set("online")` returns to `online`. Threshold (1 min) owned by frontend contract. | integration |
| REQ-101 | Two tabs, one online + one afk → merged `online`. Observer sees no flap. | integration |
| REQ-102 | Two tabs both afk → merged `afk`. | integration |
| REQ-103 | Last tab disconnect → `offline`. Non-last disconnect → merged recompute (no flap). | integration |
| REQ-104 | p95 propagation latency < 2000 ms over 50 trials (online/afk transitions); `GET /api/v1/presence` initial load returns coherent snapshot with `since` precise enough for the client ordering rule (§5). | integration (timing + REST) |
| REQ-105 | Block → blocker sees blockee as `offline`, blockee sees blocker as `offline`; unrelated user sees real state; unblock restores. Per-caller block filter applied in REST (Q8 option a) and on live emit (R16). | integration (cross-spec: depends on `s2-friendship.md` block endpoint) |
