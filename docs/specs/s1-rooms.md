# Spec: S1 — Rooms (create, leave, validation)

**Status**: draft (2026-04-19)
**Branch**: `feat/s1-rooms` (worktree to be created off `main`)
**Owner (human)**: Tatianka
**Owner (agent)**: Claude Code — S1 rooms agent
**Scope**: v4 REQ-020 (S1 data model — documentation only; schema already present), REQ-021 (room name rules), REQ-022 (room description), REQ-023 (create public room endpoint), REQ-024 (room creation rate limit), REQ-027 (leave room endpoint). v4 REQ-028 (room membership cap = 1000) is deferred to `s2-rooms.md` — see §7.

**REQ-ID alignment vs. v4 catalog:**

| ID | v4 meaning | How S1 implements it |
| --- | --- | --- |
| REQ-020 | S1 tables (`user`, `session`, `room`, `room_member`, `message_seq`, `message`) | Schema already in [packages/shared/src/schema.ts](../../packages/shared/src/schema.ts); §4 R1 is a one-shot smoke test that SELECTs each table to prove presence |
| REQ-021 | Room name rules (unique, length, charset) | DTO `createRoomSchema` + case-insensitive unique index (§4 R2, R6) |
| REQ-022 | Room description (optional, bounded, normalized) | DTO `createRoomSchema.description` + NFC normalize + control-char strip (§4 R3) |
| REQ-023 | `POST /api/v1/rooms` — any authenticated user creates a public group room | New route `POST /api/v1/rooms` (§4 R4, R5); creator auto-enrolled as `role='owner'` in same transaction |
| REQ-024 | Rate limit on room creation | Dual-tier hand-rolled Redis INCR + EXPIRE helper keyed by `userId`: 3/60s burst + 20/24h sustained (§4 R7, R8) |
| REQ-027 | Leave room; owner cannot leave | New route `DELETE /api/v1/rooms/:id/members/me`; 403 `owner_cannot_leave` for owners (§4 R9, R10, R11) |

## 1. Why

v4 REQ-023, REQ-024, REQ-027 are the last S1-scope room operations not yet built. [apps/backend/src/routes/rooms.ts](../../apps/backend/src/routes/rooms.ts) currently ships join ([line 68](../../apps/backend/src/routes/rooms.ts#L68)), catalog ([line 139](../../apps/backend/src/routes/rooms.ts#L139)), and my-rooms ([line 168](../../apps/backend/src/routes/rooms.ts#L168)) — REQ-025 and REQ-026, which are claimed in [s2-rooms.md](./s2-rooms.md). With join and catalog in place but no way to create a room, the only group room on the server is the seeded `general` from [scripts/seed.ts](../../scripts/seed.ts). Without leave, users who joined a room they regret are stuck until S2's admin-remove (REQ-091) ships. Without rate-limit, a compromised account (or a curious tester) can exhaust the `room.name` namespace in seconds.

REQ-020 (S1 data model) and REQ-021 (name rules) / REQ-022 (description rules) are NOT net-new schema. The `room` table already has `name text unique` ([schema.ts:112](../../packages/shared/src/schema.ts#L112)) and `description text` ([schema.ts:113](../../packages/shared/src/schema.ts#L113)). What they lack is: (a) a case-insensitive uniqueness guarantee — `"General"` and `"general"` currently both succeed and users have no way to tell them apart in the catalog UI, and (b) any validation at the DTO boundary — the existing `visibility`/`kind` defaults mean a POST could happen with a one-character name or a 10 MB description blob. This spec closes both gaps at the zod layer + a `lower(name)` unique index.

v3.docx §2.4.1 ("Any registered user may create a chat room"), §2.4.2 (property list + "Room names are required to be unique"), and §2.4.5 ("Users may leave rooms freely. The owner cannot leave their own room. The owner may only delete the room.") are the binding behavioural spec; v4 REQ-020 … REQ-028 are the per-item traceability hooks.

## 2. Non-goals

Explicit, so reviewers don't flag:

- **Private rooms** (v4 REQ-088, REQ-089) — the `POST /api/v1/rooms` endpoint in this spec **forces** `visibility='public'` regardless of what the client sends. Private-room creation + invitations belong to `s2-rooms.md` (or a successor). Accepting the `visibility` flag now without the enforcement stack (catalog hiding, invitation-only join) would ship an observable bug.
- **Delete room** (v4 REQ-087) — the "owner may only delete the room" clause of v3.docx §2.4.5 is the other half of REQ-027; this spec ships only the leave half. Delete is S2.
- **Ownership transfer** (v4 REQ-086) — no way to hand ownership to another member. The owner is stuck until delete ships.
- **Room ban / remove-from-room** (v4 REQ-091) — admins cannot remove members; users cannot be banned. S2.
- **Role matrix / admin actions** (v4 REQ-092–REQ-095) — there is no `POST /rooms/:id/members/:userId/admin`, no ban audit. Creator becomes `role='owner'` and that's the only role assignment this spec touches.
- **Catalog search** (v4 REQ-025 second clause — "simple search over the catalog") — the `GET /rooms` handler returns all public group rooms unfiltered. Search is UI-side for S1 or deferred.
- **Catalog / join endpoints** — REQ-025 (`GET /rooms`) and REQ-026 (`POST /rooms/:id/members`) are claimed in [s2-rooms.md](./s2-rooms.md); this spec does not redeclare them.
- **Membership cap enforcement** (v4 REQ-028) — the 1000/room cap from v3.docx §3.1 is enforced on the **join** path, which lives in `s2-rooms.md`. See §7 for the cross-spec pointer.
- **Room name updates / description edits** — no `PATCH /rooms/:id`. Name and description are set at create time and frozen for S1. Rename is not in v3.docx §2.4 at all.
- **Soft-delete semantics** — the `room.deleted_at` column exists but this spec does not populate or consume it. The case-insensitive unique index filters by `deleted_at IS NULL` so a future delete-room spec (S2) can free the name.
- **UI for create/leave** — this spec is backend-only. The web client work (create-room modal + leave-confirm dialog) belongs to the web spec and is not gated by this spec beyond the DTO contract.

## 3. User stories

- As Anna (authenticated), I can `POST /api/v1/rooms` with `{ name: "Book club", description: "We meet Tuesdays." }` and the server creates a public group room, inserts me as its owner, and returns 201 with the new room's id so I can subscribe to it immediately. (v4 REQ-023)
- As Anna, if I try to create a second room named `"book club"` (same lowercase as an existing `"Book Club"`), the server returns 409 `name_taken` — no duplicate row is inserted and the case-variant can't squat the namespace. (v4 REQ-021)
- As Anna, if I submit a name with only two characters or containing `"$"`, the server returns 400 with the zod validation error. (v4 REQ-021)
- As Anna, if I submit a description containing a bell character (`\u0007`) or de-normalized Unicode (`é` as `e + U+0301`), the stored `description` is pure NFC with the control character stripped. (v4 REQ-022)
- As a script with Anna's cookie, my 4th `POST /api/v1/rooms` in a 60-second window returns 429 with `retryAfterSec`. My 21st in a 24-hour window also returns 429 (sustained bucket). (v4 REQ-024)
- As Anna (a regular member), I `DELETE /api/v1/rooms/:id/members/me` on a room I belong to; the server returns 204 and my `room_member` row is removed. On next catalog fetch my UI shows I'm no longer a member. (v4 REQ-027)
- As Anna (an owner), I `DELETE /api/v1/rooms/:id/members/me` on a room I own; the server returns 403 `owner_cannot_leave`. My only option is to delete the room (deferred to S2). (v4 REQ-027 / v3.docx §2.4.5)
- As Anna, I call `DELETE /api/v1/rooms/:id/members/me` on a room I was never a member of; the server returns 204 (idempotent) — no 404, no state leak. (REST norm, repo precedent [s2-friendship.md R12](./s2-friendship.md))

## 4. Requirements (testable)

`pnpm trace` greps `tests/` for each REQ-ID. Test `describe` / `test` names MUST embed them verbatim.

- [ ] **R1 (REQ-020)**: The `room`, `room_member`, `message_seq`, `message` tables from [schema.ts](../../packages/shared/src/schema.ts) provide the columns this spec references: `room.name`, `room.description`, `room.kind`, `room.visibility`, `room.ownerId`, `room.deletedAt`, `room_member.role`, `message_seq.seq`. A one-shot smoke test asserts each of the three S1 tables this spec touches accepts a zero-row SELECT — `SELECT 1 FROM room LIMIT 0`, same for `room_member` and `message_seq`. The test's describe/test name embeds `REQ-020` so trace resolves it. (This is intentionally trivial; the real data-model-integrity coverage lives in the round-trip tests for every other R-number in this spec.)
- [ ] **R2 (REQ-021)**: `createRoomSchema` in [packages/shared/src/dto.ts](../../packages/shared/src/dto.ts) defines `name`: `z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9 _-]+$/).transform((s) => s.normalize("NFC"))`. Tests: a unit test exercises the schema with (a) 2-char name → 400, (b) 65-char name → 400, (c) `"hi$"` → 400, (d) `"Book Club"` → passes, (e) `" Book Club "` → passes with trim to `"Book Club"`, (f) `"Book" + U+0301` → stored as NFC composed form.
- [ ] **R3 (REQ-022)**: `createRoomSchema.description` is `z.string().max(500).optional().transform((s) => s?.normalize("NFC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""))`. Tests: (a) omitted → stored as `null`, (b) 501 chars → 400, (c) contains `"\u0007"` (bell) → stored with the bell stripped, (d) de-normalized `é` → stored as NFC.
- [ ] **R4 (REQ-023 happy path)**: `POST /api/v1/rooms` with a valid body from an authenticated user returns 201 with `{ id, name, description, visibility: "public", ownerId, createdAt }` where `ownerId === callerUserId`, `visibility === "public"` regardless of what the client sent. The DB state after the call: one new `room` row with `kind='group'`, `visibility='public'`, `ownerId=caller`, `dmPairKey=null`; one new `room_member` row with `userId=caller`, `roomId=newRoom.id`, `role='owner'`; one new `message_seq` row with `roomId=newRoom.id, seq=0`. All three inserts MUST be wrapped in a single `db.transaction` call — verified by code review, not by a runtime partial-failure test. (A mocked FK error would require either patching drizzle or throwing inside the handler body, both of which test the mock more than the behaviour.)
- [ ] **R5 (REQ-023 auth gate)**: `POST /api/v1/rooms` without a better-auth session cookie returns 401. Verified by an integration test with no `Cookie` header.
- [ ] **R6 (REQ-021 case-insensitive unique)**: Migration in [infra/migrations/](../../infra/migrations/) performs two ops in a single file: (a) `ALTER TABLE room DROP CONSTRAINT room_name_unique` (or whatever drizzle-kit named the original `name text unique`), (b) `CREATE UNIQUE INDEX room_name_ci_uq ON room (lower(name)) WHERE kind='group' AND deleted_at IS NULL`. Dropping the old case-sensitive constraint is REQUIRED for correct 409 handling — otherwise an exact-case duplicate (`"Book Club"` twice) fires the old constraint's violation name instead of `room_name_ci_uq`, and the `isUniqueViolation(err, "room_name_ci_uq")` branch in the handler misses it. Test: create room `"Book Club"` (201), then create `"Book Club"` again (409 `{ error: "name_taken" }`), then create `"book club"` (409 `{ error: "name_taken" }`). DB row count = 1 for this name cluster throughout.
- [ ] **R7 (REQ-024 burst)**: Using the hand-rolled `checkRoomCreateRateLimit(userId)` helper (see §5), the 4th `POST /api/v1/rooms` within a 60-second rolling window returns 429 with body `{ error: "rate_limited", retryAfterSec }` where `retryAfterSec` is the TTL on the burst Redis key (`rate:room-create-burst:<userId>`). Test harness calls `flushRedis()` in `beforeEach` (existing pattern in the friend-rate-limit test suite), then fires 4 sequential creates with 4 distinct names using a single authenticated agent; asserts the first 3 are 201 and the 4th is 429 with `retryAfterSec > 0 && retryAfterSec <= 60`.
- [ ] **R8 (REQ-024 sustained)**: The 21st successful create within 24h returns 429 from the sustained bucket (`rate:room-create-sustained:<userId>`, TTL 86400s). Clean test shape: `flushRedis()` in `beforeEach`; directly seed the sustained key at the Redis level — `await c.set('rate:room-create-sustained:<userId>', SUSTAINED_LIMIT); await c.expire(key, 86400)` — and leave the burst key unset; then fire one `POST /api/v1/rooms` from that user; assert 429 with `retryAfterSec > 60` (proves it's the sustained bucket, not burst). A companion unit test of `checkRoomCreateRateLimit` in isolation covers the helper's branching (burst-only-over, sustained-only-over, both-over → max-TTL) without round-tripping through Fastify. Test names MUST contain `REQ-024` to trace.
- [ ] **R9 (REQ-027 happy path)**: `DELETE /api/v1/rooms/:id/members/me` with the caller authenticated and `role='member'` in `room_member` for `:id` → 204, and the matching `room_member` row is deleted. DB row for that `(userId, roomId)` pair is absent after the call. Other `room_member` rows for the same user (other rooms) are untouched.
- [ ] **R10 (REQ-027 idempotent non-member)**: `DELETE /api/v1/rooms/:id/members/me` where the room **exists** but the caller has no `room_member` row for `:id` returns 204 (no error). (The room-does-not-exist case is R12's 404 and takes precedence — the handler MUST check room existence first, membership second.) Rationale: DELETE is idempotent per REST norms and the friendship spec's R12 precedent. Test: call leave twice on the same existing room; both return 204, DB row count unchanged after the second call.
- [ ] **R11 (REQ-027 owner-cannot-leave)**: `DELETE /api/v1/rooms/:id/members/me` where the caller has `role='owner'` for `:id` returns 403 with body `{ error: "owner_cannot_leave" }`. The `room_member` row is NOT deleted. Test: create a room (caller becomes owner via R4), immediately call leave, assert 403 + row-present.
- [ ] **R12 (REQ-027 room-not-found)**: `DELETE /api/v1/rooms/:nonexistent/members/me` returns 404 — distinct from the 204 non-member case. Test: call leave with a random UUID that has no `room` row; assert 404.
- [ ] **R13 (REQ-027 auth gate)**: `DELETE /api/v1/rooms/:id/members/me` without a session cookie returns 401.
- [ ] **R14 (transverse)**: Every route in this spec resolves `userId` via `auth.api.getSession({ headers: toFetchHeaders(request) })` — same pattern as [routes/sessions.ts:21-22](../../apps/backend/src/routes/sessions.ts#L21-L22). No handler reads `userId` from query params or request body.
- [ ] **R15 (transverse)**: `POST /api/v1/rooms` response body MUST NOT include internal fields (`deletedAt`, `dmPairKey`, raw timestamps in non-ISO format). The zod `roomCreateResponseSchema` (new, in `dto.ts`) enumerates the allowed response keys; response handler passes through that schema before replying. Test: assert response body has exactly the keys `["id", "name", "description", "visibility", "ownerId", "createdAt"]`. Note: `kind` is intentionally omitted — this endpoint only creates `kind='group'` rooms, so the field adds no information for the web client. A future endpoint that creates DMs or private rooms would need to resurface `kind` and/or widen `visibility` in its own response schema.

## 5. Design notes

**Data model changes**: drop the case-sensitive unique + add a case-insensitive partial unique index. Per CLAUDE.md, [packages/shared/src/schema.ts](../../packages/shared/src/schema.ts) is the single source of truth — the migration must be emitted by `pnpm db:generate` from a schema.ts edit, NOT hand-written. If we hand-write the SQL, the next `db:generate` re-adds the dropped `UNIQUE` constraint because schema.ts still has `name: text("name").unique()`.

**schema.ts edit** — two changes to the `room` pgTable at [schema.ts:107-135](../../packages/shared/src/schema.ts#L107-L135):

```ts
// Before (schema.ts:112):
name: text("name").unique(),
// After:
name: text("name"),
```

…then add a partial unique index inside the table's index block (precedent: the `dmPairUq` index at [schema.ts:131-133](../../packages/shared/src/schema.ts#L131-L133) uses the same shape):

```ts
(t) => ({
  visibilityIdx: index("room_visibility_idx").on(t.visibility, t.deletedAt),
  kindIdx: index("room_kind_idx").on(t.kind),
  dmPairUq: uniqueIndex("room_dm_pair_uq")
    .on(t.dmPairKey)
    .where(sql`${t.kind} = 'dm'`),
  // NEW — REQ-021 case-insensitive uniqueness, partial on group rooms only.
  // DM rooms (kind='dm') have name=NULL; soft-deleted rooms free their name.
  nameCiUq: uniqueIndex("room_name_ci_uq")
    .on(sql`lower(${t.name})`)
    .where(sql`${t.kind} = 'group' AND ${t.deletedAt} IS NULL`),
}),
```

`pnpm db:generate` then emits an `infra/migrations/<NN>_*.sql` that: (a) `ALTER TABLE room DROP CONSTRAINT room_name_unique` (or whatever drizzle-kit originally named the constraint), (b) `CREATE UNIQUE INDEX room_name_ci_uq ON room (lower(name)) WHERE kind = 'group' AND deleted_at IS NULL`. The implementer verifies the emitted SQL against this spec before running `pnpm db:migrate`.

Dropping the case-sensitive constraint is REQUIRED for correct 409 handling (see §4 R6). The handler's `isUniqueViolation(err, "room_name_ci_uq")` check branches on the constraint name from the pg error detail — if the old constraint survives, an exact-case duplicate fires under the old name and 409-handling misses it.

**New DTOs** in [packages/shared/src/dto.ts](../../packages/shared/src/dto.ts):

```ts
export const createRoomSchema = z.object({
  name: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9 _-]+$/)
    .transform((s) => s.normalize("NFC")),
  description: z
    .string()
    .max(500)
    .optional()
    .transform((s) =>
      s?.normalize("NFC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""),
    ),
});
export type CreateRoomInput = z.infer<typeof createRoomSchema>;

export const roomCreateResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  visibility: z.literal("public"),
  ownerId: z.string(),
  createdAt: z.string().datetime(),
});
```

**New API endpoints**:

- `POST /api/v1/rooms` — handled in [apps/backend/src/routes/rooms.ts](../../apps/backend/src/routes/rooms.ts). Middleware stack: auth guard (R14) → rate limit burst (R7) → rate limit sustained (R8) → zod parse (`createRoomSchema`) → transaction handler.
- `DELETE /api/v1/rooms/:id/members/me` — same file. Middleware: auth guard → handler that (a) checks `room` exists (R12), (b) checks caller's role (R11), (c) conditionally deletes `room_member` row.

**Rate limit helper** (REQ-024): new file `apps/backend/src/lib/room-create-rate-limit.ts`, modeled on [friend-rate-limit.ts](../../apps/backend/src/lib/friend-rate-limit.ts). `getClient()` and the module-scope client cache follow `friend-rate-limit.ts` exactly (lazy connect-on-demand, single persistent `RedisClientType`, `closeRoomCreateRateLimit()` for Vitest teardown). `RateLimitOutcome` is `{ allowed: boolean; retryAfterSec: number }` — the same type `friend-rate-limit.ts` exports; if this spec is the second importer, promote the type into a shared helper. Dual-tier via two Redis keys per user:

```ts
const BURST_WINDOW_SECONDS = 60;
const BURST_LIMIT = 3;
const SUSTAINED_WINDOW_SECONDS = 24 * 60 * 60;
const SUSTAINED_LIMIT = 20;

export async function checkRoomCreateRateLimit(userId: string): Promise<RateLimitOutcome> {
  const c = await getClient();
  const burstKey = `rate:room-create-burst:${userId}`;
  const sustainedKey = `rate:room-create-sustained:${userId}`;
  const [burstCount, sustainedCount] = await Promise.all([c.incr(burstKey), c.incr(sustainedKey)]);
  if (burstCount === 1) await c.expire(burstKey, BURST_WINDOW_SECONDS);
  if (sustainedCount === 1) await c.expire(sustainedKey, SUSTAINED_WINDOW_SECONDS);
  const burstOver = burstCount > BURST_LIMIT;
  const sustainedOver = sustainedCount > SUSTAINED_LIMIT;
  if (!burstOver && !sustainedOver) return { allowed: true, retryAfterSec: 0 };
  // When both buckets are over, the caller is still denied until the LONGER TTL (sustained)
  // clears — telling them to retry in 10s would be a lie.
  const ttls = await Promise.all([
    burstOver ? c.ttl(burstKey) : Promise.resolve(0),
    sustainedOver ? c.ttl(sustainedKey) : Promise.resolve(0),
  ]);
  const retryAfterSec = Math.max(...ttls, 1);
  return { allowed: false, retryAfterSec };
}
```

Rationale for hand-rolled Redis over @fastify/rate-limit: (a) the codebase already has two precedents ([friend-rate-limit.ts](../../apps/backend/src/lib/friend-rate-limit.ts) single-tier, inline `checkJoinRateLimit` at [rooms.ts:42-59](../../apps/backend/src/routes/rooms.ts#L42-L59) single-tier), so this keeps the pattern consistent; (b) @fastify/rate-limit's `keyGenerator` runs before auth middleware, which makes per-user keying awkward — the inline-after-auth approach sidesteps that; (c) no new dependency.

Buckets both INCR on every attempt, including rejected ones — the friend-rate-limit test convention. Rejected requests still burn the sustained bucket; this is intentional — the burst rate-limit is not a free retry window. An attacker pounding the endpoint burns sustained quota even while burst says no, so the 429-storm caps at the sustained ceiling rather than recovering every 60s.

**Route handler sketch (create)**:

```ts
app.post("/rooms", async (req, reply) => {
  const session = await auth.api.getSession({ headers: toFetchHeaders(req) });
  if (!session) return reply.code(401).send({ error: "unauthenticated" });
  const rl = await checkRoomCreateRateLimit(session.user.id);
  if (!rl.allowed) {
    return reply.code(429).send({ error: "rate_limited", retryAfterSec: rl.retryAfterSec });
  }
  const parsed = createRoomSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const { name, description } = parsed.data;
  const roomId = crypto.randomUUID();
  try {
    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(room).values({
        id: roomId, name, description: description ?? null,
        kind: "group", visibility: "public", ownerId: session.user.id,
      }).returning();
      await tx.insert(roomMember).values({
        id: crypto.randomUUID(), userId: session.user.id, roomId, role: "owner",
      });
      await tx.insert(messageSeq).values({ roomId, seq: 0n });
      return row;
    });
    return reply.code(201).send(roomCreateResponseSchema.parse({
      id: created.id, name: created.name, description: created.description,
      visibility: "public", ownerId: created.ownerId!,
      createdAt: created.createdAt.toISOString(),
    }));
  } catch (err) {
    if (isUniqueViolation(err, "room_name_ci_uq")) {
      return reply.code(409).send({ error: "name_taken" });
    }
    throw err;
  }
});
```

Rate-limit ordering: auth → rate-limit → zod → transaction. Putting rate-limit before zod is deliberate — invalid-body requests still cost a bucket token, matching the [rooms.ts:74-82](../../apps/backend/src/routes/rooms.ts#L74-L82) comment: "bucketless lookups are free enumeration."

**Route handler sketch (leave)**:

```ts
app.delete<{ Params: { id: string } }>("/rooms/:id/members/me", async (req, reply) => {
  const session = await auth.api.getSession({ headers: toFetchHeaders(req) });
  if (!session) return reply.code(401).send({ error: "unauthenticated" });
  const { id: roomId } = req.params;
  const [roomRow] = await db.select({ id: room.id }).from(room).where(eq(room.id, roomId)).limit(1);
  if (!roomRow) return reply.code(404).send({ error: "room_not_found" });
  const [membership] = await db.select({ role: roomMember.role })
    .from(roomMember)
    .where(and(eq(roomMember.userId, session.user.id), eq(roomMember.roomId, roomId)))
    .limit(1);
  if (membership?.role === "owner") {
    return reply.code(403).send({ error: "owner_cannot_leave" });
  }
  await db.delete(roomMember).where(
    and(eq(roomMember.userId, session.user.id), eq(roomMember.roomId, roomId)),
  );
  return reply.code(204).send();
});
```

**Security/auth**: Standard better-auth session cookie via `toFetchHeaders` + `auth.api.getSession`. No new auth surface. The case-insensitive unique index is the ONLY mechanism that prevents name squatting — the zod regex allows spaces so `"  foo  "` trims to `"foo"` and collides with an existing `"foo"` room; relying purely on zod without the DB index would let two concurrent inserts both pass validation and both succeed.

**Transactional safety**: Create is a three-row INSERT across `room`, `room_member`, `message_seq`. All three MUST be in the same transaction — verified by code review of the handler (the R4 test checks post-conditions on the happy path but not partial-failure rollback, since that would require mocking drizzle). Without the transaction, a crash between the `room` INSERT and the `room_member` INSERT would leave a room nobody can post to (the message-auth check in [apps/backend/src/lib/message-auth.ts](../../apps/backend/src/lib/message-auth.ts) rejects posts from non-members).

## 6. Tasks (each <2h, R-numbers map to §4)

1. [ ] **Schema edit + generated migration** (R6). Edit [packages/shared/src/schema.ts](../../packages/shared/src/schema.ts):
   - Drop `.unique()` from `name: text("name")` at [line 112](../../packages/shared/src/schema.ts#L112).
   - Add a new `nameCiUq` entry inside the `room` table's index block, using the `dmPairUq` precedent at [schema.ts:131-133](../../packages/shared/src/schema.ts#L131-L133) — shape per §5 above (`uniqueIndex("room_name_ci_uq").on(sql\`lower(...)\`).where(sql\`... kind = 'group' AND deleted_at IS NULL\`)`).
   - Run `pnpm db:generate`. Inspect the emitted `infra/migrations/NNNN_*.sql`: it should contain the `ALTER TABLE room DROP CONSTRAINT ...` for the old case-sensitive unique (the constraint's exact name is drizzle-kit-generated, likely `room_name_unique`) and `CREATE UNIQUE INDEX room_name_ci_uq ON room (lower(name)) WHERE kind = 'group' AND deleted_at IS NULL`. Paste the `\d+ room` output from a fresh migrated DB as a leading comment in the generated migration file — this confirms the dropped constraint's exact name and gives future auditors proof of the before/after state.
   - Run `pnpm db:migrate`.
2. [ ] **DTOs** (R2, R3, R15). Add `createRoomSchema` + `roomCreateResponseSchema` to `dto.ts` with unit tests for every branch in R2 + R3.
3. [ ] **POST /rooms handler** (R4, R5, R15). Add the transactional route. Unit test the happy path + 401.
4. [ ] **Rate limit helper** (R7, R8). Create `apps/backend/src/lib/room-create-rate-limit.ts` mirroring [friend-rate-limit.ts](../../apps/backend/src/lib/friend-rate-limit.ts) structure (connect-on-demand client, INCR + EXPIRE-on-first, `checkRoomCreateRateLimit(userId)` export, `closeRoomCreateRateLimit()` for teardown). Dual-tier with two Redis keys. Unit test for the helper's three over-limit branches (burst-only, sustained-only, both → max-TTL). Integration test R7 fires 4 sequential creates; R8 directly seeds the sustained Redis key then fires one create.
5. [ ] **Name-collision handler** (R6 second half). Add `isUniqueViolation(err, constraintName)` helper if not already present; wire pg error code `23505` to return 409 on `room_name_ci_uq`. Verify constraint name matches what the migration creates.
6. [ ] **DELETE /rooms/:id/members/me handler** (R9, R10, R11, R12, R13). Write all five tests up front (TDD); implement the handler; all green.
7. [ ] **Cross-spec sync for REQ-028** (§7). **Cross-cutting edit — coordinate with s2-rooms.md owner before merging.** Add a new R-number in `s2-rooms.md §4` for REQ-028 (`SELECT count(*) FROM room_member WHERE room_id=:id` in the join transaction; if ≥ 1000 → 403 `{ error: "room_full", cap: 1000 }`); land the s2-rooms.md change in a separate commit (or PR) to keep the bisect path clean if the s2-rooms.md owner has work in flight. Update this spec's §7 to cross-link the new R-number once it lands.
8. [ ] **REQ-020 smoke assertion** (§4 R1). Add a trivial `describe("REQ-020 S1 schema presence", () => { test("room/room_member/message_seq tables accept SELECT", ...) })` that runs `SELECT 1 FROM room LIMIT 0` (and the same for `room_member` + `message_seq`). One-liner per table; silences trace's permanent "missing" report.
9. [ ] **Trace verification**. Run `pnpm trace`; confirm REQ-020, REQ-021, REQ-022, REQ-023, REQ-024, REQ-027 are all "covered".

## 7. Out of scope / follow-ups

- **REQ-028 membership cap = 1000.** Enforced on the JOIN path (`POST /api/v1/rooms/:id/members`), which lives in [s2-rooms.md](./s2-rooms.md) R2. Task 7 above adds a new R-number to `s2-rooms.md §4` with the cap check + test (SELECT count(*) FROM room_member WHERE room_id=:id >= 1000 → 403 `room_full`). Leaving REQ-028 as a cross-spec pointer rather than a §4 entry here keeps the spec owning only what this spec's code owns.
- **REQ-025 catalog search.** `GET /rooms` returns the full public-group-rooms list unfiltered. UI-side fuzzy filter or a server-side `?q=` param is future work; not gated by v3.docx §2.4.3 ("simple search") on the backend.
- **REQ-086 ownership transfer.** No `PATCH /rooms/:id/owner`. Owners are stuck until delete ships.
- **REQ-087 delete room.** The `room.deleted_at` column exists and the case-insensitive unique index respects it, so delete is low-risk when it lands — the name frees automatically.
- **REQ-088, REQ-089 private rooms + invitations.** `createRoomSchema` does not accept `visibility`. When S2 lifts this restriction, add `visibility: z.enum(["public", "private"]).default("public")` to the schema and add invitation handling to a new `invitations` endpoint.
- **REQ-091 remove-from-room / REQ-094 ban audit log.** Admin removal + ban lists are S2.
- **REQ-092–REQ-095 role matrix.** `role` enum supports owner/admin/member; this spec only assigns `owner` on create. Admin promotion + demotion are S2.
- **Rate-limit eviction / observability.** The hand-rolled helper has no metrics emission or admin bypass. For a real production deploy, add: (a) a Prometheus counter for 429s (observability), (b) a `RATE_LIMIT_DISABLED=true` env flag for load-tests that legitimately exceed the sustained bucket, (c) a per-`userId` exception list for trusted automation. Not in S1 scope.
- **Name reservation list.** No block on `"general"`, `"admin"`, `"api"`, etc. The seeded `general` room ([scripts/seed.ts](../../scripts/seed.ts)) will collide with a user attempt to create `"general"` via the CI unique index, returning 409 — this is correct for S1. A reserved-names list is a follow-up.
- **Migration-before-seed ordering (confirmed).** The `general` seed row is idempotent (`onConflictDoNothing` per [scripts/seed.ts](../../scripts/seed.ts) header comment) and runs AFTER migrations in every environment: docker-compose gates `seed` on `service_completed_successfully` of `migrate` ([docker-compose.yml](../../docker-compose.yml)), `pnpm db:migrate && pnpm db:seed` is sequential, and CI follows the same pattern. The CI unique index is therefore active before `seed` runs, so the seed's `INSERT` of `"general"` either succeeds (fresh DB) or is a no-op (existing DB) — never a constraint violation.
- **Room description HTML/markdown.** Description is plain text with control chars stripped. No markdown rendering, no link auto-linkification, no length-aware truncation in the catalog UI.

## 8. Open questions

- [ ] **Q1 — 409 vs 422 on name collision.** REST debate: is a duplicate name a validation error (422) or a state conflict (409)? Recommendation: 409 — the input is syntactically valid; it's only rejected because of DB state. Matches the friendship spec's choice for duplicate-request (s2-friendship.md R6 uses 409 too).
- [ ] **Q2 — Should `description` default to empty string or `null` when omitted?** Stored value differs observably (`SELECT description FROM room`). Schema column is nullable. Recommendation: `null` when omitted — matches column-level "unknown" vs "intentionally blank". UI layer coerces null → "" for display. Reviewer confirms.
- [ ] **Q3 — Trim-then-validate order.** zod's `.trim()` runs before `.min(3)`, so `"   a   "` becomes `"a"` (length 1) and fails `min(3)`. Intended behaviour. Test in R2(e) covers this. Flagged here so reviewers don't "fix" it.

## 9. Acceptance test outline (REQ → test mapping)

| REQ-ID | Test assertion | Test level |
| --- | --- | --- |
| REQ-020 | `SELECT 1 FROM room/room_member/message_seq LIMIT 0` smoke test (Task 8) | integration |
| REQ-021 | Name length / charset / trim / NFC (R2 unit) + case-insensitive collision 409 (R6 integration) | unit + integration |
| REQ-022 | Description length / NFC / control-strip / omitted-is-null (R3 unit) | unit |
| REQ-023 | POST /rooms 201 happy path + DB row state + auth gate + response shape (R4, R5, R15) | integration |
| REQ-024 | 4th create in 60s → 429 burst (R7) + 21st create in 24h → 429 sustained (R8) | integration |
| REQ-027 | Leave 204 happy (R9) + idempotent non-member (R10) + owner 403 (R11) + room-404 (R12) + auth 401 (R13) | integration |
| REQ-028 | Covered in `s2-rooms.md` — cross-spec | integration (other spec) |

## 10. Gate criteria (before merging feat/s1-rooms)

- [ ] `pnpm --filter backend test:run` green.
- [ ] `pnpm trace` reports REQ-020, REQ-021, REQ-022, REQ-023, REQ-024, REQ-027 as covered.
- [ ] `pnpm typecheck` green across the workspace.
- [ ] Manual smoke: `pnpm dev` → register alice → `POST /api/v1/rooms` via the `/api-test.http` or curl → 201 → `DELETE /api/v1/rooms/:id/members/me` → 403 (alice is owner).
- [ ] `docker compose up` still green (this spec does not change infra compose; migration auto-runs on backend boot).
