# Spec: S2 — AFK Presence (three-state: online / afk / offline, multi-tab merged)

**Status**: draft (2026-04-18)
**Branch**: `feat/s2-afk-presence` (worktree to be created off `main` after S1 merge)
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code — S2 presence agent
**Scope**: REQ-099 … REQ-105 (three-state presence, 1-min AFK threshold, multi-tab merge rules, propagation SLO). Extends the S1 binary presence (`REQ-041`) into the three-state model without breaking S1 subscribers.

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
- As Bob subscribing to the room, on initial load I get the current presence state for each member via a REST endpoint (not an event replay) — see §5. After that, live updates arrive as `presence.state` events. (REQ-099)
- As Bob, presence for users I don't share any room/DM with does NOT fanout to my sockets (optimization — §8 Q2 decides whether this ships in S2 or S3).
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
- [ ] **R8 (REQ-103 abrupt disconnect)**: Crash / network drop also triggers the Socket.IO `disconnect` handler, same path as R7. Test: force-close the socket (`socket.disconnect(true)` without a graceful close) — registry still clears, offline event fires. Socket.IO's `connectionStateRecovery` window ([socket.ts:29](../../apps/backend/src/socket.ts#L29)) is 2 minutes; during that window, a same-socket reconnect is transparent to presence — the disconnect/connect pair MUST NOT flap offline→online (the socket-id in the registry is the same across recovery, so no registry mutation). Test: simulate recovery; assert NO presence events during the recovery window.
- [ ] **R9 (REQ-104 propagation SLO <2s)**: From the moment the server receives `presence.set("afk")` (or the first connect, or the last disconnect) to the moment the event is delivered to a subscribed observer socket, wall-clock latency MUST be ≤2000 ms at the 95th percentile in a single-backend-process test. Test: 50 trials of alice-set-afk → measure observer receive time; assert p95 < 2000 ms (expected typical: <50 ms). Production SLO monitoring is out of scope (S3).
- [ ] **R10 (REQ-105 server-pushed initial state via REST)**: `GET /api/v1/presence?userIds=a,b,c,…` returns `{ states: Array<{ userId, state, since }> }` for up to 100 user IDs per call. States computed from the per-user Redis registry (Lua script or pipelined GETs). Missing user (no registry key) → `state: "offline", since: null`. Called by the frontend once per room-member-panel load; after that, live updates arrive via sockets. Test: mix of online/afk/offline users, assert each row matches registry.
- [ ] **R11 (REQ-105 auth on REST + sockets)**: `GET /api/v1/presence` and `presence.set` both require a valid better-auth session. REST: missing cookie → 401. Socket: missing session was already checked on connect (S1 R9). `presence.set` has NO per-call auth check beyond the socket-already-authed baseline — the socket's bound userId is trusted. Test: socket bound as alice cannot emit `presence.set` pretending to be bob (the event payload doesn't even have a userId — the server reads `socket.data.userId`; spoofing impossible by design).
- [ ] **R12 (global fanout semantics)**: `presence.state` is emitted via `io.emit` (global fanout, same as S1). Per §8 Q2, S2 stays with global emit; scoping by room-co-membership is S3 follow-up. Test: observer subscribed only to an unrelated room still receives alice's transitions (documents the current behavior; this test is updated to a negative assertion when Q2 flips to scoped).
- [ ] **R13 (Redis registry shape)**: Per-user key `presence:user:<userId>` is a hash mapping `socketId → tabState` (`"online" | "afk"`). Computation of merged state = read the hash, apply the R5 reducer. TTL: none — entries are explicitly added on connect / removed on disconnect. If a backend process dies without cleaning up (SIGKILL, OOM), stale entries linger — mitigated by the boot-time purge (R14). Alternative shape flagged in §8 Q3.
- [ ] **R14 (boot-time registry purge)**: On backend start, iterate `presence:user:*` keys with the Socket.IO server ID (`io.engine.generateId()` or similar) baked into the hash field, and remove entries whose owning server is this one — because if we just restarted, our sockets from the previous run are gone but their entries may remain. Implementation detail: hash field is `<serverId>:<socketId>` rather than just `<socketId>`, so boot knows which to clean. First-boot (no prior entries) is a no-op. Test: simulate "leftover" entries via direct Redis writes; start a backend instance; assert our entries are purged, other instances' entries are untouched.
- [ ] **R15 (transverse: socket auth still enforced)**: The presence.set handler receives the socket's bound userId from the handshake auth (S1 R9); no additional session check per event. Missing session on socket → connection already rejected. Test is transitive from S1's REQ-038 test; no duplicate coverage.

## 5. Design notes

### Client-side idle detection (out of scope implementation, in scope contract)

The 1-minute threshold (REQ-100) is detected **in the browser**, not the server. The server can't see mouse movement in a tab; asking "how long has this socket been idle" is the wrong question because a socket may be fully subscribed yet the user went to get coffee. The frontend owns:

- A per-tab idle timer, reset on `mousemove` / `keydown` / `click` / `touchstart` / `visibilitychange` (when page visible).
- On timer reaching 60s → emit `presence.set("afk")`.
- On any resume event after AFK → emit `presence.set("online")`.
- On page unload / tab close → socket naturally disconnects (Socket.IO fires `disconnect`).

This spec stipulates the contract the frontend must honor (v3.docx §2.2.2 "more than 1 minute"). The frontend implementation lives in `s2-web.md`. Backend test harness uses direct socket emits to simulate the frontend.

### Per-user presence registry

Redis key pattern: `presence:user:<userId>` → HASH mapping `<serverId>:<socketId>` → `"online" | "afk"`.

Why Redis not in-process memory: the backend already has a Redis adapter wired ([socket.ts:38](../../apps/backend/src/socket.ts#L38)) for Socket.IO fanout. If the deploy ever scales to 2+ backend processes (S3 horizontal scale), each process only sees its local sockets; a cross-process presence calculation needs shared state. Redis is that shared state. For S2's single-process deploy, the Redis calls are cheap (<1 ms local) and the code is already scale-ready.

Why a HASH not a SET or bitmap: the per-socket *tab state* is part of the value, not just presence/absence. `HGETALL presence:user:<userId>` returns every socket's tab state in one round-trip; the reducer runs in-process. Cardinality: at most `tabs_per_user × 1` entries per user; we expect ≤ 5 at the demo scale.

Why serverId in the hash field: boot-time purge (R14). Without it, a backend crash + restart leaves orphan entries claiming the user is still connected to this process.

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

### Socket.IO surface

**No new events.** We reuse:
- `"presence.state"` (server → client) — existing, see [protocol.ts:76](../../packages/shared/src/protocol.ts#L76).
- `"presence.set"` (client → server) — existing, see [protocol.ts:83](../../packages/shared/src/protocol.ts#L83).

**One new REST endpoint**: `GET /api/v1/presence`.

**No new DB tables or columns.** Presence is Redis-only transient.

### Interaction with S1's binary emit

S1's [socket.ts](../../apps/backend/src/socket.ts) (as of s1-chat.md R12) emits `presence.state` on every connect/disconnect with global fanout. S2 replaces that code path: the new emit path is gated by transitions in the merged state, not raw socket events. The S1 R12 test ("two-distinct-user setup: observer watches subject connect → online; B disconnects → offline") still passes against the S2 implementation — that scenario has one tab per user, where every socket event IS a transition. The S1 limitation note about "two tabs for the same user will flap" becomes an R2/R3 assertion ("no flap") in S2.

### `since` semantics

The `since` field ([protocol.ts:59](../../packages/shared/src/protocol.ts#L59)) is the timestamp of the MOST RECENT TRANSITION into the current state, NOT the timestamp of the last tab-level change. Example: alice connects at T0 → `online since T0`. Tab goes afk at T0+90s, flips merged state → `afk since T0+90s`. Tab back to online at T0+120s → `online since T0+120s`. If alice's afk event didn't flip merged state (another tab still online), `since` doesn't update because the state didn't change. Rationale: clients showing "alice has been afk for X seconds" get a meaningful X. Documented so frontends can render a "since 10:45" tooltip if they want (out of scope, just reserving the contract).

### Horizontal scale — the short version

At 300 concurrent users across 2–3 backend processes (S3 hypothetical), the presence registry Redis keys are shared; every process can compute every user's merged state from `HGETALL`. Emits use `io.emit` which the Redis adapter fans out across processes (already configured). The snapshot key + the serverId-scoped hash field mean no process double-emits a transition another process already broadcast. S2 stays single-process but the design doesn't reshape when S3 scales out.

## 6. Tasks (each <2h, R-numbers map to §4)

1. [ ] **Presence registry module** — `apps/backend/src/lib/presence.ts`. Pure Redis helpers: `addSocket(userId, socketId, state)`, `removeSocket(userId, socketId)`, `setSocketState(userId, socketId, state)`, `computeMergedState(userId)`, `getSnapshot(userId)`, `setSnapshot(userId, state)`. Unit tests (no socket, direct Redis): R5 reducer branches (3-socket permutations), boot-time purge (R14).
2. [ ] **Socket.IO wiring (R2, R7, R8)** — extend `apps/backend/src/socket.ts`. Connect handler → `addSocket` + maybe-emit; disconnect handler → `removeSocket` + maybe-emit. Integration test via two socket clients (observer + subject), distinct users, covers S1 R12 parity.
3. [ ] **presence.set handler (R3, R4)** — Socket.IO event handler. Read `socket.data.userId` (set during handshake auth — S1 R9); call `setSocketState`; maybe-emit. Test: afk-online-afk sequence, assert exactly the right sequence of observer events.
4. [ ] **Multi-tab merge (R5, R6)** — integration. Two sockets per subject (simulating two tabs). Walk through the R5 branch matrix: (online, afk) → online, (afk, afk) → afk, (online, online) → online, closing one online tab leaving one afk → afk. No flap on second-tab events that don't change merged state.
5. [ ] **Snapshot + emit-on-change (implicit across R2-R7)** — `presence.ts` tests. Snapshot key written every transition; read on next compute; no emit when state unchanged. Test a same-state `presence.set("online")` on an already-online user: no emit, snapshot unchanged.
6. [ ] **Last-tab disconnect → offline (R7, R8)** — covered by R7 integration test; add abrupt-disconnect branch. Also assert `since` timestamp freshness (within 1s of test wall clock).
7. [ ] **connectionStateRecovery interaction (R8)** — integration. Force a disconnect that triggers Socket.IO recovery; reconnect with the same socketId within 2 min; assert NO presence events during the recovery, registry state stable. If recovery is too fiddly to test, XFAIL with a comment and fall back to manual verification.
8. [ ] **Propagation latency (R9)** — `presence-latency.test.ts`. 50-trial loop: subject emits `presence.set("afk")`, observer records receive time; assert p95 under 2000 ms. Local timings will be <50 ms; the test is there as a regression guard.
9. [ ] **REST `GET /api/v1/presence` (R10, R11)** — `apps/backend/src/routes/presence.ts`. Register under `/api/v1`. Mixed fixture (3 online, 2 afk, 2 offline, 1 never-connected); assert returned array matches registry. Unauth → 401.
10. [ ] **Zod validation on query (R10, §8 Q4)** — `presenceQuerySchema = z.object({ userIds: z.string().transform(s => s.split(",")).pipe(z.array(z.string()).min(1).max(100)) })`. Boundary tests: 100 ids → 200; 101 → 400.
11. [ ] **Global emit semantics (R12)** — `presence-fanout.test.ts`. Observer subscribed to an unrelated room receives subject's state changes. Documents current scope; when Q2 flips, this test is rewritten to the negative assertion.
12. [ ] **Boot-time purge (R14)** — `presence-boot-purge.test.ts`. Seed Redis with keys containing this-serverId and another-serverId; start backend; assert only this-serverId entries are gone.
13. [ ] **S1 parity test still passes** — run S1's REQ-041 test against the S2 implementation. Two-distinct-user observer/subject connect → `online`, disconnect → `offline`. No code change expected; belt-and-suspenders.
14. [ ] **Gate dry-run** — Manual: open alice in two tabs; bob in a third. Bob sees alice `online`. Let alice's first tab idle 70s → bob sees `online` (other tab active). Let alice's second tab also idle 70s → bob sees `afk` within 2s of the second set. Click in tab 1 → `online`. Close both alice tabs → `offline` within 2s.

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

- **Blocks nothing critical — scope confirmations**: Q1 (deferred idle detection to frontend — consultation only), Q2 (global vs scoped fanout — one-line flip).
- **Blocks task 1 (registry shape)**: Q3 (HASH vs. two keys). Default in R13 is HASH; Q3 confirms.
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
- [ ] Initial room-member-panel load returns correct presence states for all listed users via `GET /api/v1/presence`
- [ ] p95 latency test under 2000 ms (expected <50 ms single-process local)
- [ ] Boot-time purge reliably clears only this server's orphan entries
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
| REQ-104 | p95 propagation latency < 2000 ms over 50 trials. | integration (timing) |
| REQ-105 | `GET /api/v1/presence?userIds=a,b,c` returns current states for initial panel load; auth required; query capped at 100. | integration (REST) |
