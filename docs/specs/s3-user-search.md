# Spec: User directory search + New-DM dialog

**Status**: draft
**Branch**: `feat/s3-user-search`
**Owner (human)**: Tatiana
**Owner (agent)**: Claude Code

## 1. Why

A user who wants to DM or friend someone they've seen in a public room has no way to look them up today. The only exact-match paths are:

- `POST /api/v1/friends/requests` with `toUsername` — requires typing the *exact* handle; a miss returns `404 user_not_found`.
- `POST /api/v1/dms` with `userId` — requires having already learned the target's opaque UUID (friendship listing is the only legitimate source).

Channels already have name search (`GET /api/v1/rooms?q=…`, §2.4.3). Users don't. The gap is UX, not security posture: usernames are already visible on every public-room message (`message.authorUsername`), and the friend-request 404 oracle already leaks existence per-attempt. A proper directory endpoint replaces "guess the handle" + "interrogate 404s" with a typeahead that's rate-limited and relationship-aware.

Scope this round: the single interactive entry point that matches the reported pain — the **New-DM dialog**. Friend-requests page keeps its existing exact-username input unchanged.

## 2. Non-goals

- No generic `/people` page, no command-palette-style global search, no chat-shell-level search bar.
- No changes to `POST /api/v1/dms` or `POST /api/v1/friends/requests` shape. The new endpoint feeds userIds into those, nothing more.
- No changes to channel search (already shipped in `s2-catalog-emoji-unread.md` R1).
- No pagination. Hard cap 20; the user types more characters to narrow.
- No fuzzy matching (trigram / pg_trgm / Levenshtein). ILIKE substring only.
- No recent-searches persistence, no result caching, no server-side prefetch.
- No changes to the friend-requests page or the `/friends` list.

## 3. User stories

- As a user who wants to DM Bob and knows only "bob" or "Bob Someone", I can open a "+ New DM" dialog, type two characters, and see a ranked list of matching users with a button that does the right thing for my relationship with each (Start DM, Send friend request, etc.), so that I don't have to guess handles or leave the DM list.
- As a user whose username is "bob", I do NOT appear in search results for anyone I have blocked, nor for anyone who has blocked me, so that block is symmetric and the endpoint is not an oracle that leaks block state.
- As a user, I cannot scrape the full user directory through this endpoint: a rate limit throttles sustained querying, a 2-character minimum blocks empty / single-letter broadcasts, and a 20-result cap blocks bulk-fetch.

## 4. Requirements (testable)

Each requirement has a test hook. Test names MUST contain the literal tokens `§2.3` (friendship), `§2.4` (DMs), or `REQ-UserSearch` so `pnpm trace` picks them up.

- [ ] **R1**: `GET /api/v1/users?q=<term>` with `term.length < 2` returns `400 invalid_query`. Same response for missing `q`, empty `q`, whitespace-only `q`.
- [ ] **R2**: `q.length > 64` returns `400 invalid_query`.
- [ ] **R3**: Unauthenticated request returns `401 unauthorized`.
- [ ] **R4** (rank 0 — exact username): result where `username = q` (case-sensitive in the equality branch of the ORDER BY; ILIKE still matches regardless of case) sorts before any other tier.
- [ ] **R5** (rank 1 — exact name): result where `name = q` sorts after exact-username hits and before any prefix hit. Tie-broken alphabetically on `username`.
- [ ] **R6** (rank 2 / 3 — prefix): `username ILIKE q || '%'` outranks `name ILIKE q || '%'`; both outrank any contains-only hit.
- [ ] **R7** (rank 4 / 5 — substring): `username ILIKE '%' || q || '%'` (but no prefix match) outranks `name ILIKE '%' || q || '%'`.
- [ ] **R8** (tiebreak): within any single tier, results sort by `username ASC`.
- [ ] **R9**: the caller never appears in their own search results, even if `q` matches their own username/name.
- [ ] **R10**: soft-deleted users (`deleted_at IS NOT NULL`) never appear.
- [ ] **R11**: users the caller has blocked (`user_block` row with `by_id = callerId, target_id = hitId`) never appear.
- [ ] **R12**: users who have blocked the caller (`user_block` row with `by_id = hitId, target_id = callerId`) never appear. R11 + R12 symmetry is two separate tests.
- [ ] **R13** (relationship — friend): when a `friendship` row exists for the normalized pair, the hit has `relationship: "friend"`.
- [ ] **R14** (relationship — outgoing): when a `friend_request` row with `from_id = callerId, to_id = hitId, status = 'pending'` exists, the hit has `relationship: "request_outgoing"`.
- [ ] **R15** (relationship — incoming): when a `friend_request` row with `from_id = hitId, to_id = callerId, status = 'pending'` exists, the hit has `relationship: "request_incoming"`.
- [ ] **R16** (relationship — none): absence of any of the above, the hit has `relationship: "none"`. `friend` takes precedence if both a friendship and a request exist (post-unfriend-with-stale-request edge case, see §5).
- [ ] **R17**: result set is hard-capped at 20 rows even when more than 20 users match. The 21st best-ranked hit does NOT appear.
- [ ] **R18** (rate limit — documented, tested if feasible): ≥61 requests within 60s from the same authenticated user returns `429 rate_limited` on the 61st. The test is gated behind a shorter-window test config if the 60s bucket is impractical in CI; otherwise covered by a test comment + integration trace.
- [ ] **R19** (web — NewDmDialog mounts): on `/dms` (or the current DM-list route), a "+ New DM" button mounts a dialog containing an `<input type="search">` with placeholder "Search by name or username" and an empty list region.
- [ ] **R20** (web — debounce): typing in the search input does NOT fire a request until both (a) the value has `trim().length >= 2` and (b) 300ms have elapsed since the last keystroke.
- [ ] **R21** (web — friend row): a row with `relationship: "friend"` renders a primary "Start DM" button; clicking calls `createDm(userId)` and navigates to the returned `roomId`.
- [ ] **R22** (web — none row): a row with `relationship: "none"` renders a primary "Send friend request" button; clicking calls `POST /api/v1/friends/requests` with `{ toUserId }` and swaps the button to "Request sent" on 201 (no dialog close).
- [ ] **R23** (web — outgoing row): a row with `relationship: "request_outgoing"` renders a disabled "Request sent" button.
- [ ] **R24** (web — incoming row): a row with `relationship: "request_incoming"` renders an "Accept" button that navigates to the existing friend-requests page (deep-linked — no inline accept).
- [ ] **R25** (e2e — happy path): Alice + Bob are friends. Alice opens "+ New DM", types "bob", sees Bob with "Start DM", clicks it, lands on the DM room. One Playwright spec covers this end-to-end.

## 5. Design notes

### DTO + protocol

**`packages/shared/src/dto.ts`** — append:

```ts
// REQ-UserSearch — directory search query param. Min 2 chars to make
// whole-table enumeration impossible by API shape; max 64 matches the
// rooms-catalog `q` ceiling (s2-catalog-emoji-unread.md R2).
export const userSearchQuerySchema = z.object({
  q: z.string().min(2).max(64),
});
export type UserSearchQuery = z.infer<typeof userSearchQuerySchema>;
```

**`packages/shared/src/protocol.ts`** — append:

```ts
export type UserRelationship =
  | "friend"
  | "request_outgoing"
  | "request_incoming"
  | "none";

export interface UserSearchHit {
  userId: string;
  username: string;
  name: string;
  relationship: UserRelationship;
}
```

### Backend route

**New file**: `apps/backend/src/routes/users.ts`. Registered in `apps/backend/src/app.ts` alongside the other `app.register(..., { prefix: "/api/v1" })` calls.

**Why a new file and not append to `friendship.ts`?** `friendship.ts` is already the longest route file in the repo (~650 lines) and owns the mutable friendship-graph surface. A read-only directory endpoint with its own rate-limit bucket + ranking SQL belongs in a standalone module; mixing it into friendship.ts would make the "is this endpoint about graph state or discovery?" distinction fuzzy.

**Handler skeleton**:

```ts
// R1 / R2 — query validation
const parsed = userSearchQuerySchema.safeParse(request.query);
if (!parsed.success) return reply.status(400).send({ error: "invalid_query" });
const q = parsed.data.q.trim();
if (q.length < 2) return reply.status(400).send({ error: "invalid_query" });

// R3 — auth gate
const ctx = await requireUserSearchAuth(request, reply);
if (!ctx) return;

// Main query — see §5 "Ranking SQL" below. Returns { id, username, name }[]
// ordered by tier then username, limit 20, with self + deleted + both-block
// exclusions applied.
const rows = await searchUsers(ctx.userId, q);
if (rows.length === 0) return reply.status(200).send({ users: [] });

// Relationship enrichment — one batched read across friendship +
// friend_request, resolved into a Map<userId, UserRelationship>.
const hitIds = rows.map((r) => r.id);
const relationshipByUser = await resolveRelationships(ctx.userId, hitIds);

const users: UserSearchHit[] = rows.map((r) => ({
  userId: r.id,
  username: r.username,
  name: r.name,
  relationship: relationshipByUser.get(r.id) ?? "none",
}));

return reply.status(200).send({ users });
```

### Rate limit

Use `@fastify/rate-limit` route config, same pattern as the tight friend-request bucket in `friendship.ts`. `keyGenerator` reads the session cookie via `auth.api.getSession({ headers })` and returns `session.user.id`; unauthenticated fallback returns the IP so the 401 path can't be abused to burn per-IP buckets off the directory surface.

Config: `{ max: 60, timeWindow: "1 minute" }`. Matches §3 non-goal "no bulk scraping" while leaving headroom for a 300ms-debounced typeahead during active typing bursts.

### Ranking SQL

One SELECT with a CASE-ordered rank. Postgres syntax (Drizzle raw SQL fragments for the CASE; rest is Drizzle query builder). The `%` / `_` ILIKE metacharacters in `q` are NOT escaped — same precedent as rooms catalog (s2-catalog-emoji-unread.md §5).

```sql
SELECT u.id, u.username, u.name,
  CASE
    WHEN u.username = :q THEN 0
    WHEN u.name     = :q THEN 1
    WHEN u.username ILIKE :q || '%' THEN 2
    WHEN u.name     ILIKE :q || '%' THEN 3
    WHEN u.username ILIKE '%' || :q || '%' THEN 4
    ELSE 5  -- must match u.name ILIKE '%' || :q || '%' to be in the result set
  END AS rank
FROM "user" u
WHERE u.deleted_at IS NULL
  AND u.id <> :callerId
  AND (u.username ILIKE '%' || :q || '%' OR u.name ILIKE '%' || :q || '%')
  AND u.id NOT IN (SELECT target_id FROM user_block WHERE by_id = :callerId)
  AND u.id NOT IN (SELECT by_id FROM user_block WHERE target_id = :callerId)
ORDER BY rank ASC, u.username ASC
LIMIT 20;
```

Performance note: the WHERE's `user_block` subqueries are small per-user (hackathon-scale; a typical user blocks <10). On the `user` table, the ILIKE substring scan is linear at ≤300 concurrent users (v3.docx scale target) — acceptable without trigram indexes. If the target grows by 10x, revisit with `pg_trgm` + GIN index (deferred, §7).

### Relationship enrichment

Two batched reads over the at-most-20 returned userIds:

```ts
// Friendships where caller is userA or userB with any of the hits.
const fships = await db.select({ userA: friendship.userAId, userB: friendship.userBId })
  .from(friendship)
  .where(or(
    and(eq(friendship.userAId, callerId), inArray(friendship.userBId, hitIds)),
    and(eq(friendship.userBId, callerId), inArray(friendship.userAId, hitIds)),
  ));

// Pending requests in either direction with any of the hits.
const requests = await db.select({ fromId: friendRequest.fromId, toId: friendRequest.toId })
  .from(friendRequest)
  .where(and(
    eq(friendRequest.status, "pending"),
    or(
      and(eq(friendRequest.fromId, callerId), inArray(friendRequest.toId, hitIds)),
      and(eq(friendRequest.toId, callerId), inArray(friendRequest.fromId, hitIds)),
    ),
  ));
```

Precedence in the mapping (R16): `friend` > `request_outgoing` / `request_incoming` > `none`. Friend wins because a stale `friend_request` row can linger post-unfriend (see friendship.ts:231-254 comment on the pending/accepted/friendship three-way dance); if the friendship row currently exists, the pair IS friends, regardless of any lingering pending request row.

### Frontend — NewDmDialog

**New component**: `apps/web/src/components/chat/NewDmDialog.tsx`. Uses shadcn `Dialog` + `Input` (both already installed).

**Trigger**: add a "+ New DM" `<Button variant="outline">` at the top of the existing DM list page. Location: wherever `listDms()` from `dms-api.ts` currently renders — confirm during implementation; single button, no layout gymnastics.

**Component surface** (lean — no stored "recent search" state, no remembered scroll position):

```tsx
interface NewDmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Internal state: query string, hits array, loading flag, last-fired-q
// (so a stale 300ms timer doesn't clobber fresher results).
```

**Debounce** (R20): a `useEffect` keyed on the input value. If `value.trim().length < 2`, clear hits and skip; otherwise `setTimeout(() => searchUsers(value.trim()).then(setHits), 300)`. Cleanup cancels the timer. Matches the composer-draft debounce pattern elsewhere in the app.

**Row rendering**:

```tsx
function relationshipAction(hit: UserSearchHit) {
  switch (hit.relationship) {
    case "friend":            return <Button onClick={...}>Start DM</Button>;
    case "none":              return <Button onClick={...}>Send friend request</Button>;
    case "request_outgoing":  return <Button disabled>Request sent</Button>;
    case "request_incoming":  return <Button variant="secondary" onClick={goToRequests}>Accept</Button>;
  }
}
```

Row visual: `<div class="flex items-center justify-between">{username + name stack}{action button}</div>`. No avatars (avatars aren't a thing elsewhere in the app yet — adding them here would be scope creep).

**Empty / loading states**:
- `q.trim().length < 2`: "Type at least 2 characters" hint.
- Request in flight: skeleton row × 3.
- Request done, hits empty: "No users match '<q>'".
- Request failed (network / 429 / 500): "Search failed — try again in a moment." No retry button; next keystroke re-fires.

**Client API** — extend `apps/web/src/lib/dms-api.ts`:

```ts
export async function searchUsers(q: string): Promise<DmResult<UserSearchHit[]>> {
  // GET /api/v1/users?q=<encoded>. Response: { users: UserSearchHit[] }.
  // Errors: invalid_query (400, should never escape client-side guards),
  // unauthorized (401), rate_limited (429), network/unknown.
}
```

Extend `DmErrorCode` union with `"rate_limited"` and `"invalid_query"`; both already possible at the network layer, previously just lumped under `"unknown"`.

### Security / auth notes

- Endpoint is authenticated-only (R3). Unauthenticated callers get 401 before the rate-limit bucket is charged to a user key.
- Block symmetry (R11/R12) is the critical privacy gate. The two NOT IN subqueries are the primary defense; verify both with separate tests.
- ILIKE parameters flow through Drizzle's placeholder binding, so `%` / `_` in user input is literal — no wildcard-escape concern.
- The endpoint is NOT a DM-abuse vector: `isDmAllowed` in `routes/dms.ts` still gates every DM create on friendship + no-block. Search only shrinks the discovery step; it does not widen the action surface.
- Rate limit keyed on `userId` (not IP) so shared NATs don't punish legitimate users for one noisy neighbor.

## 6. Tasks (3-8, each <2h)

**Branch**: `feat/s3-user-search` off main. Worktree per `project-docker-e2e-stack` conventions.

1. [ ] Add DTO (`userSearchQuerySchema`) + protocol types (`UserRelationship`, `UserSearchHit`) in `packages/shared`. Run `pnpm --filter shared typecheck` green. Commit.
2. [ ] Write failing backend test `apps/backend/tests/users-search.test.ts` covering R1–R18 (R18 via short-window override or comment-only if too heavy). Test names MUST include the literal strings **"REQ-UserSearch"** and **"§2.4"** so `pnpm trace` matches. Red.
3. [ ] Implement `apps/backend/src/routes/users.ts` + register in `app.ts`. Helper functions `searchUsers(callerId, q)` and `resolveRelationships(callerId, hitIds)` live in the same file unless either exceeds ~80 lines (in which case extract to `src/lib/user-search.ts`). Run `pnpm --filter backend test:run users-search` green. Commit.
4. [ ] Extend `apps/web/src/lib/dms-api.ts` with `searchUsers` + widened `DmErrorCode`. Commit.
5. [ ] Write failing RTL tests for `NewDmDialog.tsx` covering R19–R24. Describe block MUST include **"§2.4"** and **"NewDmDialog"**. Red.
6. [ ] Implement `NewDmDialog.tsx` + wire the "+ New DM" trigger into the DM list page. Run `pnpm --filter web test:run NewDmDialog` green. Commit.
7. [ ] Write Playwright spec `tests/e2e/user-search-dm.spec.ts` covering R25 (Alice searches "bob", clicks "Start DM", lands on DM). Name MUST include **"§2.4"**. Run against the docker-compose stack per `project-docker-e2e-stack` guidance. Commit.
8. [ ] Gate checks: `pnpm trace` reports green on `§2.4` / `REQ-UserSearch`, `pnpm --filter backend test:run`, `pnpm --filter web typecheck && pnpm --filter web test:run`, `pnpm --filter web build`. Batched smoke via docker compose per `feedback-batched-smoke`.

## 7. Out of scope / follow-ups

- **Trigram / fuzzy ranking** — if ILIKE substring feels dumb for misspellings ("tatian" finding "Tatiana" works; "tatanna" does not), revisit with `pg_trgm` + GIN index. Deferred to S4.
- **Global `/people` page + command palette** — natural follow-up once the dialog proves the UX. Spec separately.
- **Channel search in the same dialog** — merging rooms + users into one picker is out of scope; rooms already search from `/rooms/browse`, keep it there for now.
- **Recent-searches persistence** — no local-storage state, no server-side history. Add only if users ask.
- **Inline "Accept friend request"** — R24 routes to the existing friend-requests page. Inline acceptance is an additive follow-up once the relationships-in-search UX is live.

## 8. Open questions

- [ ] Where exactly does the "+ New DM" button mount? Current DM-list renderer is in (to confirm during implementation — `apps/web/src/app/dms/page.tsx` or a component under `apps/web/src/components/chat/`). Resolve in task 6, not a blocker for approval.
- [ ] Is there a v3.docx REQ-ID that this fills that I haven't mapped? If so, swap `REQ-UserSearch` tokens to the real REQ-NNN before tasks 2/5/7. If not, leave as `REQ-UserSearch` — `pnpm trace` still picks up the §-token.
