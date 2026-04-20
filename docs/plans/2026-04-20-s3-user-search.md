# User directory search + New-DM dialog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GET /api/v1/users?q=<term>` directory search + replace the current raw-userId `NewDmDialog` with a relationship-aware typeahead picker.

**Architecture:** New read-only Fastify route (`apps/backend/src/routes/users.ts`) with CASE-ranked ILIKE query, two-read relationship enrichment, 60/min per-user rate limit via `@fastify/rate-limit`. The existing `apps/web/src/components/dm/NewDmDialog.tsx` is rewritten to debounce a search field and render per-row actions keyed on `relationship`. No schema changes.

**Tech Stack:** Fastify + Drizzle + Postgres (backend), React 19 + shadcn/ui Dialog + sonner toasts (web), Vitest + Supertest (backend tests), RTL (web unit), Playwright (e2e).

**Binding spec:** [docs/specs/s3-user-search.md](../specs/s3-user-search.md). R1–R25 map 1:1 to tests.

**Spec → plan deltas discovered during plan writing:**
- Spec §5 listed `apps/web/src/components/chat/NewDmDialog.tsx` as the target path. The file already exists at `apps/web/src/components/dm/NewDmDialog.tsx` and is currently mounted by [DmList.tsx](../../apps/web/src/components/dm/DmList.tsx). **Action:** edit the existing file in place — no new file, no new mount point.
- Spec §6 Task 6 says "wire the '+ New DM' trigger into the DM list page" — already wired (`DmList.tsx:113`). **Action:** drop that subtask.
- The test-fixture password `"Hackaton_Test_Pw_2026!"` (`TEST_PASSWORD_OK` in `apps/backend/tests/helpers/fixtures.ts`) is mandatory — REQ-006's blocklist rejects `"password1234"`.

---

## File Structure

**Create:**
- `apps/backend/src/routes/users.ts` — the route + `searchUsers` + `resolveRelationships` helpers (kept in-file unless either exceeds ~80 lines, per spec §6 task 3).
- `apps/backend/tests/users-search.test.ts` — R1–R18 coverage (Supertest).
- `apps/web/src/components/dm/NewDmDialog.test.tsx` — R19–R24 coverage (RTL).
- `tests/e2e/s3-user-search.spec.ts` — R25 happy path.

**Modify:**
- `packages/shared/src/dto.ts` — append `userSearchQuerySchema`.
- `packages/shared/src/protocol.ts` — append `UserRelationship` + `UserSearchHit`.
- `apps/backend/src/app.ts` — register `usersRoutes` alongside the other `/api/v1/*` registrations.
- `apps/web/src/lib/dms-api.ts` — add `searchUsers`, widen `DmErrorCode` with `"rate_limited" | "invalid_query"`.
- `apps/web/src/components/dm/NewDmDialog.tsx` — full rewrite (keeps export name + `<NewDmDialog />` call-site contract).

---

## Working agreement

- **Branch:** `AI-dev` in `hackathon-starter-public` (per session directive — this is the public-repo AI-dev branch). Commits on `AI-dev` are pre-authorized per memory `feedback-own-branch-commits-preauthorized`.
- **Worktree:** not needed — `AI-dev` is already the checkout.
- **Commit cadence:** one commit per TDD cycle (red → green → refactor → commit). Don't batch.
- **Traceability:** every test name must contain the literal `REQ-UserSearch` and/or `§2.4` so `pnpm trace` picks it up.
- **Verification gate:** after each task, `pnpm --filter <affected-workspace> typecheck` + the relevant `test:run` command must be green before moving on. Don't claim "done" without running them.

---

## Task 1: Shared DTO + protocol types

**Files:**
- Modify: `packages/shared/src/dto.ts` (append at end)
- Modify: `packages/shared/src/protocol.ts` (append at end)

- [ ] **Step 1: Append DTO schema**

Edit `packages/shared/src/dto.ts`, add at the end of the file:

```ts
// ──────────────────────────────────────────────────────────────────────────
// User directory search (§2.4 / REQ-UserSearch) — docs/specs/s3-user-search.md
// ──────────────────────────────────────────────────────────────────────────

// Min 2 chars makes whole-table enumeration impossible by API shape.
// Max 64 matches the rooms-catalog `q` ceiling (roomCatalogQuerySchema).
export const userSearchQuerySchema = z.object({
  q: z.string().min(2).max(64),
});
export type UserSearchQuery = z.infer<typeof userSearchQuerySchema>;
```

- [ ] **Step 2: Append protocol types**

Edit `packages/shared/src/protocol.ts`, add at the end of the file:

```ts
// ──────────────────────────────────────────────────────────────────────────
// User directory search (§2.4 / REQ-UserSearch) — docs/specs/s3-user-search.md
// ──────────────────────────────────────────────────────────────────────────

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

- [ ] **Step 3: Typecheck shared**

Run: `pnpm --filter @ai-herders/shared typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/dto.ts packages/shared/src/protocol.ts
git commit -m "feat(shared): userSearchQuerySchema + UserSearchHit/UserRelationship (REQ-UserSearch)"
```

---

## Task 2: Backend route scaffold + R1/R2/R3 (query-shape + auth gate)

**Files:**
- Create: `apps/backend/tests/users-search.test.ts`
- Create: `apps/backend/src/routes/users.ts`
- Modify: `apps/backend/src/app.ts`

- [ ] **Step 1: Write the failing test file**

Create `apps/backend/tests/users-search.test.ts`:

```ts
// REQ-UserSearch §2.4 — GET /api/v1/users?q=<term>
// Binding spec: docs/specs/s3-user-search.md §4 R1–R18.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import request from "supertest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { user } from "@ai-herders/shared/schema";

import { buildApp } from "../src/app";
import { getTestDb } from "./db-helpers";
import { TEST_PASSWORD_OK } from "./helpers/fixtures";

interface SignedUpAgent {
  agent: request.Agent;
  userId: string;
}

async function userIdByEmail(email: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!row) throw new Error(`user not found: ${email}`);
  return row.id;
}

async function registerAgent(
  app: FastifyInstance,
  email: string,
  username: string,
  name = username,
): Promise<SignedUpAgent> {
  const agent = request.agent(app.server);
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, username, password: TEST_PASSWORD_OK, name })
    .expect(200);
  return { agent, userId: await userIdByEmail(email) };
}

describe("REQ-UserSearch §2.4 query-shape + auth", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-UserSearch §2.4 R3 — unauthenticated → 401", async () => {
    const res = await request(app.server).get("/api/v1/users?q=bob");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "unauthorized" });
  });

  test("REQ-UserSearch §2.4 R1 — missing q → 400 invalid_query", async () => {
    const alice = await registerAgent(app, "usrch-r1a@example.com", "usrch_r1a");
    const res = await alice.agent.get("/api/v1/users");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });

  test("REQ-UserSearch §2.4 R1 — q.length < 2 → 400 invalid_query", async () => {
    const alice = await registerAgent(app, "usrch-r1b@example.com", "usrch_r1b");
    const res = await alice.agent.get("/api/v1/users?q=a");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });

  test("REQ-UserSearch §2.4 R1 — whitespace-only q → 400 invalid_query", async () => {
    const alice = await registerAgent(app, "usrch-r1c@example.com", "usrch_r1c");
    const res = await alice.agent.get("/api/v1/users?q=%20%20");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });

  test("REQ-UserSearch §2.4 R2 — q.length > 64 → 400 invalid_query", async () => {
    const alice = await registerAgent(app, "usrch-r2@example.com", "usrch_r2");
    const res = await alice.agent.get(`/api/v1/users?q=${"a".repeat(65)}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_query" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter backend test:run users-search`
Expected: FAIL — the route doesn't exist (all 5 tests get a 404, not 400/401).

- [ ] **Step 3: Create the route scaffold**

Create `apps/backend/src/routes/users.ts`:

```ts
// User directory search — GET /api/v1/users?q=<term>.
// Binding spec: docs/specs/s3-user-search.md.
//
// Read-only module: ranking SQL + relationship enrichment + per-user rate
// limit. Kept separate from routes/friendship.ts because friendship.ts owns
// mutable graph state; a discovery endpoint with its own rate-limit bucket
// belongs in its own file (spec §5 "Why a new file").

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { userSearchQuerySchema } from "@ai-herders/shared/dto";

import { auth } from "../auth";
import { toFetchHeaders } from "../lib/fetch-headers";

interface UserSearchAuthContext {
  userId: string;
}

async function requireUserSearchAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<UserSearchAuthContext | null> {
  const headers = toFetchHeaders(request);
  const session = await auth.api.getSession({ headers });
  if (!session) {
    reply.status(401).send({ error: "unauthorized" });
    return null;
  }
  return { userId: session.user.id };
}

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get("/users", async (request, reply) => {
    const ctx = await requireUserSearchAuth(request, reply);
    if (!ctx) return;

    // R1 — parse first, then re-trim. Whitespace-only survives the zod
    // .min(2) because whitespace is still 2+ chars; catch it post-trim.
    const parsed = userSearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_query" });
    }
    const q = parsed.data.q.trim();
    if (q.length < 2) {
      return reply.status(400).send({ error: "invalid_query" });
    }

    // Filled in later tasks — ranking SQL + relationship enrichment.
    return reply.status(200).send({ users: [] });
  });
}
```

- [ ] **Step 4: Register the route in `app.ts`**

Edit `apps/backend/src/app.ts`:

After the existing import line `import { mutesRoutes } from "./routes/mutes";` (around line 30), add:

```ts
import { usersRoutes } from "./routes/users";
```

After the existing `await app.register(mutesRoutes, { prefix: "/api/v1/rooms" });` line (around line 231), add:

```ts
  await app.register(usersRoutes, { prefix: "/api/v1" });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter backend test:run users-search`
Expected: PASS — all 5 tests green.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter backend typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/routes/users.ts apps/backend/src/app.ts apps/backend/tests/users-search.test.ts
git commit -m "feat(backend): scaffold GET /api/v1/users with query-shape + auth gate (REQ-UserSearch R1-R3)"
```

---

## Task 3: Ranking SQL + R4–R10 (ranking + self + soft-delete)

**Files:**
- Modify: `apps/backend/tests/users-search.test.ts` (add describe block)
- Modify: `apps/backend/src/routes/users.ts` (add `searchUsers` helper + wire into handler)

- [ ] **Step 1: Write the failing ranking tests**

In `apps/backend/tests/users-search.test.ts`, add a new `describe` block below the existing one. Add these imports at the top if missing: `import { and, eq, inArray } from "drizzle-orm";` and keep the existing `user` import.

```ts
describe("REQ-UserSearch §2.4 ranking + self + soft-delete", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-UserSearch §2.4 R4/R5/R6/R7/R8 — tier order + tiebreak", async () => {
    // Caller
    const me = await registerAgent(app, "usrch-rank-me@example.com", "rank_me");

    // Fixtures chosen so one hit lands in each tier for query 'rank'.
    // Tier 0 exact username: username === 'rank'
    await registerAgent(app, "usrch-rank-exact@example.com", "rank", "Exact User");
    // Tier 1 exact name: name === 'rank', username different
    await registerAgent(app, "usrch-rank-exactname@example.com", "rank_b", "rank");
    // Tier 2 prefix username: 'ranker'
    await registerAgent(app, "usrch-rank-pfx-u@example.com", "ranker", "Prefix U");
    // Tier 3 prefix name: username 'zz_pn', name 'ranked Person'
    await registerAgent(app, "usrch-rank-pfx-n@example.com", "zz_pn", "ranked Person");
    // Tier 4 substring username: 'rrank_sub' (contains 'rank' but no prefix)
    await registerAgent(app, "usrch-rank-sub-u@example.com", "rrank_sub", "Sub U");
    // Tier 5 substring name only: username 'zz_sn', name 'Contains rank here'
    await registerAgent(app, "usrch-rank-sub-n@example.com", "zz_sn", "Contains rank here");

    const res = await me.agent.get("/api/v1/users?q=rank");
    expect(res.status).toBe(200);
    const usernames = (res.body.users as Array<{ username: string }>).map(
      (u) => u.username,
    );
    // Expected strict order — tie on tiebreak is alphabetical ASC.
    expect(usernames).toEqual([
      "rank",        // tier 0
      "rank_b",      // tier 1
      "ranker",      // tier 2
      "zz_pn",       // tier 3
      "rrank_sub",   // tier 4
      "zz_sn",       // tier 5
    ]);
  });

  test("REQ-UserSearch §2.4 R8 — tiebreak alphabetical within a tier", async () => {
    const me = await registerAgent(app, "usrch-tie-me@example.com", "tie_me");
    // Two hits both in tier 4 (substring username, no prefix). 'arank_a'
    // and 'brank_a' both match '%rank%' on username but neither prefixes.
    await registerAgent(app, "usrch-tie-b@example.com", "brank_a", "B User");
    await registerAgent(app, "usrch-tie-a@example.com", "arank_a", "A User");

    const res = await me.agent.get("/api/v1/users?q=rank");
    expect(res.status).toBe(200);
    const usernames = (res.body.users as Array<{ username: string }>).map(
      (u) => u.username,
    );
    const aIdx = usernames.indexOf("arank_a");
    const bIdx = usernames.indexOf("brank_a");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  test("REQ-UserSearch §2.4 R9 — caller never appears in own results", async () => {
    const me = await registerAgent(app, "usrch-self@example.com", "selfmatch");
    const res = await me.agent.get("/api/v1/users?q=selfmatch");
    expect(res.status).toBe(200);
    const ids = (res.body.users as Array<{ userId: string }>).map((u) => u.userId);
    expect(ids).not.toContain(me.userId);
  });

  test("REQ-UserSearch §2.4 R10 — soft-deleted users never appear", async () => {
    const me = await registerAgent(app, "usrch-sd-me@example.com", "sd_me");
    const ghost = await registerAgent(app, "usrch-sd-ghost@example.com", "sd_ghost");

    // Soft-delete directly via DB (matches existing tombstone shape —
    // deleted_at + email/username rewrite in account.ts).
    await getTestDb()
      .update(user)
      .set({ deletedAt: new Date() })
      .where(eq(user.id, ghost.userId));

    const res = await me.agent.get("/api/v1/users?q=sd_ghost");
    expect(res.status).toBe(200);
    const ids = (res.body.users as Array<{ userId: string }>).map((u) => u.userId);
    expect(ids).not.toContain(ghost.userId);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter backend test:run users-search`
Expected: previous 5 tests PASS, new 4 tests FAIL — all current responses are `{users: []}` (empty), so the expected usernames arrays are missing.

- [ ] **Step 3: Implement the ranking SQL helper**

Edit `apps/backend/src/routes/users.ts`. Add imports at the top:

```ts
import { and, eq, ne, or, sql, isNull, ilike, notInArray, inArray } from "drizzle-orm";
import { friendRequest, friendship, user, userBlock } from "@ai-herders/shared/schema";
import type { UserRelationship, UserSearchHit } from "@ai-herders/shared/protocol";
import { db } from "../db";
```

Add below the `requireUserSearchAuth` helper, above `export async function usersRoutes`:

```ts
interface UserSearchRow {
  id: string;
  username: string;
  name: string;
}

async function searchUsers(
  callerId: string,
  q: string,
): Promise<UserSearchRow[]> {
  // Ranking SQL — CASE expression drives ORDER BY. Tiebreak is username ASC.
  // `q` flows through Drizzle's placeholder binding (sql`${q}`), so the
  // ILIKE wildcards in user input are literal — same precedent as
  // routes/rooms.ts:253 rooms-catalog search.
  const rankExpr = sql<number>`CASE
    WHEN ${user.username} = ${q} THEN 0
    WHEN ${user.name}     = ${q} THEN 1
    WHEN ${user.username} ILIKE ${q + "%"} THEN 2
    WHEN ${user.name}     ILIKE ${q + "%"} THEN 3
    WHEN ${user.username} ILIKE ${"%" + q + "%"} THEN 4
    ELSE 5
  END`;

  // Exclude users the caller blocked …
  const blockedByCaller = db
    .select({ id: userBlock.targetId })
    .from(userBlock)
    .where(eq(userBlock.byId, callerId));
  // … and users who have blocked the caller.
  const blockedCaller = db
    .select({ id: userBlock.byId })
    .from(userBlock)
    .where(eq(userBlock.targetId, callerId));

  const rows = await db
    .select({
      id: user.id,
      username: user.username,
      name: user.name,
      rank: rankExpr,
    })
    .from(user)
    .where(
      and(
        isNull(user.deletedAt),
        ne(user.id, callerId),
        or(
          ilike(user.username, `%${q}%`),
          ilike(user.name, `%${q}%`),
        ),
        notInArray(user.id, blockedByCaller),
        notInArray(user.id, blockedCaller),
      ),
    )
    .orderBy(rankExpr, user.username)
    .limit(20);

  return rows.map(({ rank: _rank, ...rest }) => rest);
}
```

Now update the handler body in `usersRoutes`. Replace the placeholder `return reply.status(200).send({ users: [] });` with:

```ts
    const rows = await searchUsers(ctx.userId, q);
    if (rows.length === 0) {
      return reply.status(200).send({ users: [] });
    }

    // Relationship enrichment lands in Task 5 — until then every hit is
    // "none". Tests for R13–R16 will drive the real implementation.
    const users: UserSearchHit[] = rows.map((r) => ({
      userId: r.id,
      username: r.username,
      name: r.name,
      relationship: "none" as UserRelationship,
    }));

    return reply.status(200).send({ users });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter backend test:run users-search`
Expected: all 9 tests PASS (5 from Task 2 + 4 new).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter backend typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/users.ts apps/backend/tests/users-search.test.ts
git commit -m "feat(backend): ranking SQL + self/soft-delete exclusion (REQ-UserSearch R4-R10)"
```

---

## Task 4: Block exclusion R11–R12

**Files:**
- Modify: `apps/backend/tests/users-search.test.ts` (add describe block)
- No route changes needed — `searchUsers` from Task 3 already handles this.

- [ ] **Step 1: Write the failing block tests**

In `apps/backend/tests/users-search.test.ts`, add a new `describe` block. Add `userBlock` to the schema import if not already present:

```ts
import { friendship, friendRequest, user, userBlock } from "@ai-herders/shared/schema";
```

Add the describe block:

```ts
describe("REQ-UserSearch §2.4 block symmetry", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-UserSearch §2.4 R11 — hits blocked BY caller are excluded", async () => {
    const me = await registerAgent(app, "usrch-blk-me@example.com", "blk_me");
    const blockedTarget = await registerAgent(
      app,
      "usrch-blk-target@example.com",
      "blk_target",
    );
    await getTestDb().insert(userBlock).values({
      id: "ub-r11",
      byId: me.userId,
      targetId: blockedTarget.userId,
    });

    const res = await me.agent.get("/api/v1/users?q=blk_target");
    expect(res.status).toBe(200);
    const ids = (res.body.users as Array<{ userId: string }>).map((u) => u.userId);
    expect(ids).not.toContain(blockedTarget.userId);
  });

  test("REQ-UserSearch §2.4 R12 — hits who have blocked caller are excluded", async () => {
    const me = await registerAgent(app, "usrch-blk2-me@example.com", "blk2_me");
    const blocker = await registerAgent(
      app,
      "usrch-blk2-blocker@example.com",
      "blk2_blocker",
    );
    await getTestDb().insert(userBlock).values({
      id: "ub-r12",
      byId: blocker.userId,
      targetId: me.userId,
    });

    const res = await me.agent.get("/api/v1/users?q=blk2_blocker");
    expect(res.status).toBe(200);
    const ids = (res.body.users as Array<{ userId: string }>).map((u) => u.userId);
    expect(ids).not.toContain(blocker.userId);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm --filter backend test:run users-search`
Expected: all 11 tests PASS. The exclusion was already built into `searchUsers` in Task 3 — these tests just verify it.

If either test fails, re-check the `notInArray(user.id, blockedByCaller)` / `notInArray(user.id, blockedCaller)` subqueries in `searchUsers`. Do not loosen the test.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/tests/users-search.test.ts
git commit -m "test(backend): block symmetry coverage (REQ-UserSearch R11-R12)"
```

---

## Task 5: Relationship enrichment R13–R17

**Files:**
- Modify: `apps/backend/tests/users-search.test.ts` (add describe block)
- Modify: `apps/backend/src/routes/users.ts` (add `resolveRelationships` helper + wire into handler)

- [ ] **Step 1: Write the failing relationship + cap tests**

In `apps/backend/tests/users-search.test.ts`, add:

```ts
describe("REQ-UserSearch §2.4 relationship enrichment + cap", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-UserSearch §2.4 R13 — friend row → relationship: 'friend'", async () => {
    const me = await registerAgent(app, "usrch-fr13-me@example.com", "fr13_me");
    const buddy = await registerAgent(app, "usrch-fr13-buddy@example.com", "fr13_buddy");
    const [a, b] = me.userId < buddy.userId
      ? [me.userId, buddy.userId]
      : [buddy.userId, me.userId];
    await getTestDb().insert(friendship).values({
      id: "fs-r13",
      userAId: a,
      userBId: b,
    });

    const res = await me.agent.get("/api/v1/users?q=fr13_buddy");
    expect(res.status).toBe(200);
    const hit = (res.body.users as Array<{ userId: string; relationship: string }>)
      .find((u) => u.userId === buddy.userId);
    expect(hit?.relationship).toBe("friend");
  });

  test("REQ-UserSearch §2.4 R14 — pending outgoing request → 'request_outgoing'", async () => {
    const me = await registerAgent(app, "usrch-fr14-me@example.com", "fr14_me");
    const target = await registerAgent(app, "usrch-fr14-t@example.com", "fr14_t");
    await getTestDb().insert(friendRequest).values({
      id: "frq-r14",
      fromId: me.userId,
      toId: target.userId,
      status: "pending",
    });

    const res = await me.agent.get("/api/v1/users?q=fr14_t");
    const hit = (res.body.users as Array<{ userId: string; relationship: string }>)
      .find((u) => u.userId === target.userId);
    expect(hit?.relationship).toBe("request_outgoing");
  });

  test("REQ-UserSearch §2.4 R15 — pending incoming request → 'request_incoming'", async () => {
    const me = await registerAgent(app, "usrch-fr15-me@example.com", "fr15_me");
    const sender = await registerAgent(app, "usrch-fr15-s@example.com", "fr15_s");
    await getTestDb().insert(friendRequest).values({
      id: "frq-r15",
      fromId: sender.userId,
      toId: me.userId,
      status: "pending",
    });

    const res = await me.agent.get("/api/v1/users?q=fr15_s");
    const hit = (res.body.users as Array<{ userId: string; relationship: string }>)
      .find((u) => u.userId === sender.userId);
    expect(hit?.relationship).toBe("request_incoming");
  });

  test("REQ-UserSearch §2.4 R16 — no relationship → 'none'; friend beats stale request", async () => {
    // Case A: stranger — relationship 'none'.
    const me = await registerAgent(app, "usrch-fr16a-me@example.com", "fr16a_me");
    const stranger = await registerAgent(
      app,
      "usrch-fr16a-x@example.com",
      "fr16a_x",
    );
    const resA = await me.agent.get("/api/v1/users?q=fr16a_x");
    const hitA = (resA.body.users as Array<{ userId: string; relationship: string }>)
      .find((u) => u.userId === stranger.userId);
    expect(hitA?.relationship).toBe("none");

    // Case B: friendship + lingering accepted friend_request — friend wins.
    const me2 = await registerAgent(app, "usrch-fr16b-me@example.com", "fr16b_me");
    const buddy2 = await registerAgent(
      app,
      "usrch-fr16b-buddy@example.com",
      "fr16b_buddy",
    );
    const [aa, bb] = me2.userId < buddy2.userId
      ? [me2.userId, buddy2.userId]
      : [buddy2.userId, me2.userId];
    await getTestDb().insert(friendship).values({
      id: "fs-r16b",
      userAId: aa,
      userBId: bb,
    });
    // Stale pending request in either direction — friendship still wins.
    await getTestDb().insert(friendRequest).values({
      id: "frq-r16b",
      fromId: me2.userId,
      toId: buddy2.userId,
      status: "pending",
    });
    const resB = await me2.agent.get("/api/v1/users?q=fr16b_buddy");
    const hitB = (resB.body.users as Array<{ userId: string; relationship: string }>)
      .find((u) => u.userId === buddy2.userId);
    expect(hitB?.relationship).toBe("friend");
  });

  test("REQ-UserSearch §2.4 R17 — hard cap 20 regardless of matches", async () => {
    const me = await registerAgent(app, "usrch-cap-me@example.com", "cap_me");
    // 21 candidates all matching the same query.
    for (let i = 0; i < 21; i++) {
      const padded = String(i).padStart(2, "0");
      await registerAgent(
        app,
        `usrch-cap-${padded}@example.com`,
        `capuser${padded}`,
      );
    }

    const res = await me.agent.get("/api/v1/users?q=capuser");
    expect(res.status).toBe(200);
    const hits = res.body.users as Array<unknown>;
    expect(hits).toHaveLength(20);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter backend test:run users-search`
Expected: R13/R14/R15/R16 Case B FAIL (relationship is "none" for everyone). R16 Case A + R17 PASS.

- [ ] **Step 3: Add the relationship helper**

Edit `apps/backend/src/routes/users.ts`. Add the helper below `searchUsers`:

```ts
async function resolveRelationships(
  callerId: string,
  hitIds: string[],
): Promise<Map<string, UserRelationship>> {
  const out = new Map<string, UserRelationship>();
  if (hitIds.length === 0) return out;

  // 1. Friendships where caller is A or B and the counterpart is a hit.
  const fships = await db
    .select({ userA: friendship.userAId, userB: friendship.userBId })
    .from(friendship)
    .where(
      or(
        and(eq(friendship.userAId, callerId), inArray(friendship.userBId, hitIds)),
        and(eq(friendship.userBId, callerId), inArray(friendship.userAId, hitIds)),
      ),
    );
  for (const row of fships) {
    const other = row.userA === callerId ? row.userB : row.userA;
    out.set(other, "friend");
  }

  // 2. Pending requests in either direction — friend (already set) wins.
  const requests = await db
    .select({ fromId: friendRequest.fromId, toId: friendRequest.toId })
    .from(friendRequest)
    .where(
      and(
        eq(friendRequest.status, "pending"),
        or(
          and(eq(friendRequest.fromId, callerId), inArray(friendRequest.toId, hitIds)),
          and(eq(friendRequest.toId, callerId), inArray(friendRequest.fromId, hitIds)),
        ),
      ),
    );
  for (const row of requests) {
    const other = row.fromId === callerId ? row.toId : row.fromId;
    if (out.has(other)) continue; // friend precedence (R16)
    out.set(other, row.fromId === callerId ? "request_outgoing" : "request_incoming");
  }

  return out;
}
```

- [ ] **Step 4: Wire the helper into the handler**

In `apps/backend/src/routes/users.ts`, replace the block starting `// Relationship enrichment lands in Task 5` and ending at the `return reply.status(200).send({ users });` line with:

```ts
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

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter backend test:run users-search`
Expected: all 16 tests PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter backend typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/routes/users.ts apps/backend/tests/users-search.test.ts
git commit -m "feat(backend): relationship enrichment + 20-row cap (REQ-UserSearch R13-R17)"
```

---

## Task 6: Rate limit R18

**Files:**
- Modify: `apps/backend/src/routes/users.ts` (attach `@fastify/rate-limit` route config)
- Modify: `apps/backend/tests/users-search.test.ts` (add rate-limit test)

**Why `@fastify/rate-limit` and not a custom Redis INCR helper?** The global per-IP limiter is already wired in `app.ts` with a shared Redis client; per-route overrides via `config.rateLimit` are idiomatic in this repo (see `routes/messages.ts`). This matches spec §5 "Rate limit" verbatim and keeps the rate-limit surface single-sourced.

- [ ] **Step 1: Write the failing rate-limit test**

In `apps/backend/tests/users-search.test.ts`, add a new describe block. Import the test helper:

```ts
import { __setTestRateLimitGlobalMax } from "../src/app";
```

> Note: the global limiter's test-mode escape is only needed if the global cap (env.APP_RATE_LIMIT_GLOBAL_MAX) is lower than the per-route cap, which it isn't in CI — leave the global pinned.

For R18 we drive the 61st request to a user-scoped bucket. The route config uses `max: 60, timeWindow: "1 minute"`; calling it 61 times in fast succession from one logged-in agent should return 429 on call 61.

```ts
describe("REQ-UserSearch §2.4 rate limit", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("REQ-UserSearch §2.4 R18 — 61st request in 60s → 429 rate_limited", async () => {
    const alice = await registerAgent(app, "usrch-rl@example.com", "usrch_rl");

    // Fire 60 sequential requests — all should succeed (200).
    for (let i = 0; i < 60; i++) {
      const res = await alice.agent.get("/api/v1/users?q=nobody_matches_this");
      expect(res.status).toBe(200);
    }
    // The 61st should trip the bucket.
    const res = await alice.agent.get("/api/v1/users?q=nobody_matches_this");
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "rate_limited" });
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter backend test:run users-search`
Expected: the new R18 test FAILs — the 61st call still returns 200. All other tests stay green.

- [ ] **Step 3: Attach the per-route rate limit**

Edit `apps/backend/src/routes/users.ts`. Add this import near the top:

```ts
import { auth } from "../auth";
```

(Already imported — confirm.) The `@fastify/rate-limit` plugin, registered globally in `app.ts`, exposes `config.rateLimit` on individual routes. Update the route registration from:

```ts
  app.get("/users", async (request, reply) => {
```

to:

```ts
  app.get(
    "/users",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
          // Key on authenticated userId so shared NATs don't punish
          // legitimate users. Unauthenticated callers still hit this
          // keyGenerator before requireUserSearchAuth runs (preHandlers
          // fire after the limiter); fall back to IP so 401s can't be
          // weaponised to burn a user's bucket from a stolen cookie.
          keyGenerator: async (request) => {
            try {
              const headers = toFetchHeaders(request);
              const session = await auth.api.getSession({ headers });
              if (session?.user?.id) return `us:${session.user.id}`;
            } catch {
              // fall through to IP
            }
            return `us-ip:${request.ip}`;
          },
        },
      },
    },
    async (request, reply) => {
```

(Keep the existing handler body; only the registration signature changes — close the extra `)` at the end of the handler.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter backend test:run users-search`
Expected: all 17 tests PASS. Note — the R18 test runs ~61 sequential HTTP calls and may take a few seconds.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter backend typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/users.ts apps/backend/tests/users-search.test.ts
git commit -m "feat(backend): 60/min per-user rate limit on /api/v1/users (REQ-UserSearch R18)"
```

---

## Task 7: Client API extension

**Files:**
- Modify: `apps/web/src/lib/dms-api.ts`

- [ ] **Step 1: Extend `DmErrorCode` + add `searchUsers`**

Edit `apps/web/src/lib/dms-api.ts`.

At the top of the file, replace the existing `import` block with:

```ts
import type { DmListItem, UserSearchHit } from "@ai-herders/shared/protocol";
import { BACKEND_URL, csrfHeaders } from "./backend";
```

Update `DmErrorCode`:

```ts
export type DmErrorCode =
  | "unauthorized"
  | "validation"
  | "invalid_query"
  | "self_dm"
  | "dm_not_allowed"
  | "user_not_found"
  | "rate_limited"
  | "network"
  | "unknown";
```

Append at the bottom of the file:

```ts
// REQ-UserSearch §2.4 — directory search (docs/specs/s3-user-search.md).
// 2-char minimum is enforced on both sides: UI guards in NewDmDialog,
// backend re-validates in routes/users.ts. Error codes widened to include
// 'rate_limited' (60/min per-user) + 'invalid_query' (network-layer guard
// for the <2-char / >64-char / empty-q edges).
export async function searchUsers(q: string): Promise<DmResult<UserSearchHit[]>> {
  let res: Response;
  try {
    res = await fetch(
      `${BACKEND_URL}/api/v1/users?q=${encodeURIComponent(q)}`,
      { credentials: "include" },
    );
  } catch {
    return { ok: false, error: { code: "network" } };
  }
  if (!res.ok) return { ok: false, error: await parseError(res) };
  try {
    const data = (await res.json()) as { users: UserSearchHit[] };
    return { ok: true, data: data.users };
  } catch {
    return { ok: false, error: { code: "unknown", status: res.status } };
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/dms-api.ts
git commit -m "feat(web): searchUsers client + widen DmErrorCode (REQ-UserSearch)"
```

---

## Task 8: NewDmDialog rewrite + R19–R24

**Files:**
- Create: `apps/web/src/components/dm/NewDmDialog.test.tsx`
- Modify: `apps/web/src/components/dm/NewDmDialog.tsx` (full rewrite, keeping the export name)

- [ ] **Step 1: Write the failing RTL test file**

Create `apps/web/src/components/dm/NewDmDialog.test.tsx`:

```tsx
// REQ-UserSearch §2.4 — NewDmDialog rewrite.
// Binding spec: docs/specs/s3-user-search.md §4 R19–R24.
// Previous userId-input tests are obsolete; the dialog is now a typeahead.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserSearchHit } from "@ai-herders/shared/protocol";
import type { DmResult, CreateDmResult } from "@/lib/dms-api";
import { NewDmDialog } from "./NewDmDialog";

const searchUsersMock = vi.fn<(q: string) => Promise<DmResult<UserSearchHit[]>>>();
const createDmMock = vi.fn<(id: string) => Promise<DmResult<CreateDmResult>>>();
const pushMock = vi.fn<(path: string) => void>();

vi.mock("@/lib/dms-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/dms-api")>(
    "@/lib/dms-api",
  );
  return {
    ...actual,
    searchUsers: (q: string) => searchUsersMock(q),
    createDm: (id: string) => createDmMock(id),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

async function openDialog() {
  const user = userEvent.setup();
  render(<NewDmDialog />);
  await user.click(screen.getByRole("button", { name: /new/i }));
  return user;
}

function hit(overrides: Partial<UserSearchHit> = {}): UserSearchHit {
  return {
    userId: overrides.userId ?? "usr-bob",
    username: overrides.username ?? "bob",
    name: overrides.name ?? "Bob Bobson",
    relationship: overrides.relationship ?? "friend",
  };
}

beforeEach(() => {
  searchUsersMock.mockReset();
  createDmMock.mockReset();
  pushMock.mockReset();
});

describe("REQ-UserSearch §2.4 NewDmDialog R19 — mount + search input", () => {
  it("renders search input with placeholder + empty region", async () => {
    await openDialog();
    const input = screen.getByRole("searchbox", {
      name: /search/i,
    });
    expect(input).toHaveAttribute("placeholder", "Search by name or username");
  });
});

describe("REQ-UserSearch §2.4 NewDmDialog R20 — debounce", () => {
  it("does not fire when q.length < 2", async () => {
    const user = await openDialog();
    const input = screen.getByRole("searchbox", { name: /search/i });
    await user.type(input, "b");
    // No request fires for a single char — give the debounce a full window
    // plus buffer, then assert zero calls.
    await new Promise((r) => setTimeout(r, 400));
    expect(searchUsersMock).not.toHaveBeenCalled();
  });

  it("fires 300ms after last keystroke once q.length ≥ 2", async () => {
    searchUsersMock.mockResolvedValue({ ok: true, data: [hit()] });
    const user = await openDialog();
    const input = screen.getByRole("searchbox", { name: /search/i });
    await user.type(input, "bo");
    // Before 300ms elapse — no call yet.
    expect(searchUsersMock).not.toHaveBeenCalled();
    // After 300ms — exactly one call.
    await waitFor(
      () => {
        expect(searchUsersMock).toHaveBeenCalledTimes(1);
        expect(searchUsersMock).toHaveBeenCalledWith("bo");
      },
      { timeout: 700 },
    );
  });
});

describe("REQ-UserSearch §2.4 NewDmDialog R21 — friend row", () => {
  it("friend → 'Start DM' button creates DM and navigates", async () => {
    searchUsersMock.mockResolvedValue({
      ok: true,
      data: [hit({ relationship: "friend", userId: "usr-bob" })],
    });
    createDmMock.mockResolvedValue({
      ok: true,
      data: {
        roomId: "room-xyz",
        kind: "dm",
        dmPairKey: "pair",
        created: true,
      },
    });
    const user = await openDialog();
    const input = screen.getByRole("searchbox", { name: /search/i });
    await user.type(input, "bob");
    const startBtn = await screen.findByRole("button", { name: /start dm/i });
    await user.click(startBtn);
    await waitFor(() => {
      expect(createDmMock).toHaveBeenCalledWith("usr-bob");
      expect(pushMock).toHaveBeenCalledWith("/rooms/room-xyz");
    });
  });
});

describe("REQ-UserSearch §2.4 NewDmDialog R22 — none row", () => {
  it("none → 'Send friend request' swaps to 'Request sent' on success", async () => {
    searchUsersMock.mockResolvedValue({
      ok: true,
      data: [hit({ relationship: "none", userId: "usr-carol", username: "carol" })],
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "frq-1", status: "pending" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const user = await openDialog();
    const input = screen.getByRole("searchbox", { name: /search/i });
    await user.type(input, "carol");
    const sendBtn = await screen.findByRole("button", {
      name: /send friend request/i,
    });
    await user.click(sendBtn);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: /request sent/i }),
      ).toBeInTheDocument();
    });
    fetchSpy.mockRestore();
  });
});

describe("REQ-UserSearch §2.4 NewDmDialog R23 — outgoing row", () => {
  it("request_outgoing → disabled 'Request sent' button", async () => {
    searchUsersMock.mockResolvedValue({
      ok: true,
      data: [hit({ relationship: "request_outgoing" })],
    });
    const user = await openDialog();
    const input = screen.getByRole("searchbox", { name: /search/i });
    await user.type(input, "bob");
    const btn = await screen.findByRole("button", { name: /request sent/i });
    expect(btn).toBeDisabled();
  });
});

describe("REQ-UserSearch §2.4 NewDmDialog R24 — incoming row", () => {
  it("request_incoming → 'Accept' button routes to /friends", async () => {
    searchUsersMock.mockResolvedValue({
      ok: true,
      data: [hit({ relationship: "request_incoming" })],
    });
    const user = await openDialog();
    const input = screen.getByRole("searchbox", { name: /search/i });
    await user.type(input, "bob");
    const accept = await screen.findByRole("button", { name: /accept/i });
    await user.click(accept);
    expect(pushMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/friends/),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test:run NewDmDialog`
Expected: FAILs — the dialog still has the userId input, no searchbox role.

- [ ] **Step 3: Rewrite `NewDmDialog.tsx`**

Replace the entire content of `apps/web/src/components/dm/NewDmDialog.tsx` with:

```tsx
// NewDmDialog — directory-search typeahead with per-row relationship
// actions. Binding spec: docs/specs/s3-user-search.md §5.
//
// Row-action switch:
//   friend            → Start DM (createDm → /rooms/:roomId)
//   none              → Send friend request (POST /api/v1/friends/requests)
//   request_outgoing  → "Request sent" (disabled)
//   request_incoming  → Accept → /friends (deep-link, no inline accept)

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { UserSearchHit } from "@ai-herders/shared/protocol";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createDm, searchUsers } from "@/lib/dms-api";
import { BACKEND_URL, csrfHeaders } from "@/lib/backend";

const DEBOUNCE_MS = 300;
const MIN_QUERY = 2;

type RowStatus = "idle" | "sending" | "sent" | "dmming";

export function NewDmDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<UserSearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({});
  // Track the q that fired the last request so a stale 300ms timer
  // doesn't clobber fresher results.
  const inFlightRef = useRef<string>("");

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY) {
      setHits(null);
      setLoading(false);
      setError(null);
      return;
    }
    const handle = setTimeout(async () => {
      inFlightRef.current = trimmed;
      setLoading(true);
      setError(null);
      const r = await searchUsers(trimmed);
      if (inFlightRef.current !== trimmed) return; // stale
      setLoading(false);
      if (r.ok) {
        setHits(r.data);
      } else {
        setHits(null);
        setError("Search failed — try again in a moment.");
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHits(null);
      setLoading(false);
      setError(null);
      setRowStatus({});
    }
  }, [open]);

  async function onStartDm(hit: UserSearchHit) {
    setRowStatus((s) => ({ ...s, [hit.userId]: "dmming" }));
    const r = await createDm(hit.userId);
    if (r.ok) {
      setOpen(false);
      window.dispatchEvent(new CustomEvent("dm:created"));
      router.push(`/rooms/${r.data.roomId}`);
      return;
    }
    setRowStatus((s) => ({ ...s, [hit.userId]: "idle" }));
    toast.error("Couldn't start DM — try again.");
  }

  async function onSendFriendRequest(hit: UserSearchHit) {
    setRowStatus((s) => ({ ...s, [hit.userId]: "sending" }));
    try {
      const res = await fetch(`${BACKEND_URL}/api/v1/friends/requests`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ toUserId: hit.userId }),
      });
      if (res.status === 201 || res.status === 200) {
        setRowStatus((s) => ({ ...s, [hit.userId]: "sent" }));
      } else {
        setRowStatus((s) => ({ ...s, [hit.userId]: "idle" }));
        toast.error("Couldn't send friend request.");
      }
    } catch {
      setRowStatus((s) => ({ ...s, [hit.userId]: "idle" }));
      toast.error("Network error.");
    }
  }

  function onAccept() {
    setOpen(false);
    router.push("/friends");
  }

  function renderAction(hit: UserSearchHit) {
    const status = rowStatus[hit.userId] ?? "idle";
    if (hit.relationship === "friend") {
      return (
        <Button
          size="sm"
          disabled={status === "dmming"}
          onClick={() => onStartDm(hit)}
        >
          Start DM
        </Button>
      );
    }
    if (hit.relationship === "none") {
      if (status === "sent") {
        return (
          <Button size="sm" variant="secondary" disabled>
            Request sent
          </Button>
        );
      }
      return (
        <Button
          size="sm"
          disabled={status === "sending"}
          onClick={() => onSendFriendRequest(hit)}
        >
          Send friend request
        </Button>
      );
    }
    if (hit.relationship === "request_outgoing") {
      return (
        <Button size="sm" variant="secondary" disabled>
          Request sent
        </Button>
      );
    }
    // request_incoming
    return (
      <Button size="sm" variant="secondary" onClick={onAccept}>
        Accept
      </Button>
    );
  }

  const trimmed = query.trim();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          aria-label="Start a new DM"
        >
          + New
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a direct message</DialogTitle>
          <DialogDescription>Search for someone by name or username.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            type="search"
            role="searchbox"
            aria-label="Search users"
            autoFocus
            placeholder="Search by name or username"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          <div className="min-h-[8rem] space-y-1">
            {trimmed.length < MIN_QUERY ? (
              <div className="px-1 py-2 text-xs text-muted-foreground">
                Type at least 2 characters.
              </div>
            ) : loading ? (
              <>
                <div className="h-10 animate-pulse rounded bg-muted/40" />
                <div className="h-10 animate-pulse rounded bg-muted/40" />
                <div className="h-10 animate-pulse rounded bg-muted/40" />
              </>
            ) : error ? (
              <div className="px-1 py-2 text-xs text-destructive">{error}</div>
            ) : hits && hits.length === 0 ? (
              <div className="px-1 py-2 text-xs text-muted-foreground">
                No users match &quot;{trimmed}&quot;
              </div>
            ) : (
              hits?.map((hit) => (
                <div
                  key={hit.userId}
                  className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-accent"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">@{hit.username}</div>
                    <div className="truncate text-xs text-muted-foreground">{hit.name}</div>
                  </div>
                  {renderAction(hit)}
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test:run NewDmDialog`
Expected: all 7 tests PASS.

- [ ] **Step 5: Typecheck + build**

Run: `pnpm --filter web typecheck`
Expected: PASS.

Run: `pnpm --filter web build`
Expected: PASS (catches any Next.js-layer error the test harness misses).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/dm/NewDmDialog.tsx apps/web/src/components/dm/NewDmDialog.test.tsx
git commit -m "feat(web): NewDmDialog search typeahead + relationship actions (REQ-UserSearch R19-R24)"
```

---

## Task 9: Playwright e2e R25

**Files:**
- Create: `tests/e2e/s3-user-search.spec.ts`

- [ ] **Step 1: Write the Playwright spec**

Create `tests/e2e/s3-user-search.spec.ts`:

```ts
// REQ-UserSearch §2.4 R25 — Alice + Bob are friends; Alice opens "+ New"
// on the DM list, types "bob", clicks "Start DM", lands on the DM room.
// Binding spec: docs/specs/s3-user-search.md §4 R25.

import { test, expect, type Page, type BrowserContext } from "@playwright/test";

const BACKEND_HEALTH = "http://localhost:4000/health";

const stamp = () => Date.now().toString(36);

async function register(
  page: Page,
  u: { email: string; username: string; name: string; password: string },
): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Email").fill(u.email);
  await page.getByLabel("Username").fill(u.username);
  await page.getByLabel("Display name").fill(u.name);
  await page.getByLabel("Password", { exact: true }).fill(u.password);
  await page.getByLabel("Confirm password").fill(u.password);
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/rooms(\/|$)/, { timeout: 15_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("REQ-UserSearch §2.4 R25 — user-search DM happy path", () => {
  test.beforeAll(async () => {
    const res = await fetch(BACKEND_HEALTH).catch(() => null);
    test.skip(
      !res || !res.ok,
      `Backend not healthy at ${BACKEND_HEALTH}. Boot with: docker compose up --build -d`,
    );
  });

  test("REQ-UserSearch §2.4 — Alice searches 'bob', clicks Start DM, lands on DM", async ({
    browser,
  }) => {
    const suffix = stamp();
    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    try {
      const aliceP = await aliceCtx.newPage();
      const bobP = await bobCtx.newPage();

      const alice = {
        email: `us-${suffix}-a@herders.local`,
        username: `usa${suffix}`,
        name: "Alice",
        password: "Hackaton_Test_Pw_2026!",
      };
      const bob = {
        email: `us-${suffix}-b@herders.local`,
        username: `usb${suffix}`,
        name: "Bob Bobson",
        password: "Hackaton_Test_Pw_2026!",
      };

      await register(aliceP, alice);
      await register(bobP, bob);

      // Alice sends a friend request to Bob via the UI (friend-requests page
      // expects exact username — unchanged by this feature).
      await aliceP.goto("/friends");
      await aliceP.getByLabel(/username/i).fill(bob.username);
      await aliceP.getByRole("button", { name: /send request/i }).click();
      await expect(aliceP.getByText(/request.*sent|pending/i)).toBeVisible({
        timeout: 10_000,
      });

      // Bob accepts.
      await bobP.goto("/friends");
      await bobP.getByRole("button", { name: /accept/i }).first().click();
      await expect(bobP.getByText(alice.username)).toBeVisible({ timeout: 10_000 });

      // Alice opens "+ New" and searches Bob by partial username.
      await aliceP.goto("/rooms");
      await aliceP.getByRole("button", { name: /start a new dm/i }).click();
      await aliceP
        .getByRole("searchbox", { name: /search/i })
        .fill(bob.username.slice(0, 3));
      const startBtn = aliceP.getByRole("button", { name: /start dm/i });
      await expect(startBtn).toBeVisible({ timeout: 5_000 });
      await startBtn.click();

      // Alice lands on the DM room.
      await expect(aliceP).toHaveURL(/\/rooms\/[a-f0-9-]+/i, { timeout: 10_000 });
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
```

- [ ] **Step 2: Run the spec against the running docker-compose stack**

Boot (if not already up): `docker compose up --build -d`, wait for health, then:

Run: `pnpm --filter web exec playwright test tests/e2e/s3-user-search.spec.ts --reporter=line`
Expected: 1 test PASS.

If it fails with a selector miss, re-check the label text on the friend-requests page against the actual rendered form — update the selector, NOT the REQ-ID token. Do not narrow the assertion shape.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/s3-user-search.spec.ts
git commit -m "test(e2e): user-search DM happy path (REQ-UserSearch §2.4 R25)"
```

---

## Task 10: Gate checks + close-out

**Files:**
- No code changes — verification + doc close-out.
- Modify: `docs/FOLLOWUPS.md` (strike the deferred entry once merged; only if requested).

- [ ] **Step 1: Traceability**

Run: `pnpm trace`
Expected: PASS — `§2.4` and `REQ-UserSearch` tokens resolve to tests.

- [ ] **Step 2: Full backend test run**

Run: `pnpm --filter backend test:run`
Expected: all pre-existing tests PASS + the 17 new `users-search` tests PASS.

If the full suite trips REQ-009 sign-up rate-limit (feedback memory `feedback-signup-rate-limit-flush`), flush Redis first: `docker compose exec redis redis-cli FLUSHDB`, then re-run.

- [ ] **Step 3: Full web test run**

Run: `pnpm --filter web test:run`
Expected: PASS.

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: PASS.

- [ ] **Step 4: Batched smoke**

Per memory `feedback-batched-smoke` + `project-docker-e2e-stack`: one round of `docker compose up --build -d` + the Playwright suite subset covering DM/friends flows:

```bash
docker compose up --build -d
pnpm --filter web exec playwright test tests/e2e/s3-user-search.spec.ts tests/e2e/s2-dm-unread.spec.ts --reporter=line
```

Expected: both specs PASS.

- [ ] **Step 5: Final commit + push consideration**

If a FOLLOWUPS strike is requested, edit `docs/FOLLOWUPS.md` (change "spec written, implementation scheduled" → "shipped 2026-04-20 on AI-dev") and commit:

```bash
git add docs/FOLLOWUPS.md
git commit -m "docs(followups): close user-search — shipped on AI-dev"
```

**Do NOT push** without explicit confirmation — the public repo's push semantics haven't been clarified for this session. Report branch head SHA back to the human and await instructions.

---

## Self-review

- **Spec coverage:** every R1–R25 is claimed by a named test in tasks 2/3/4/5/6/8/9. Spec non-goals (no pagination, no fuzzy, no recent-searches) are respected — the plan does not introduce those surfaces.
- **Placeholder scan:** no "TBD"/"TODO" steps; every code block is complete; test fixtures name exact usernames + expected tier order.
- **Type consistency:** `UserSearchHit`, `UserRelationship`, `userSearchQuerySchema`, `searchUsers`, `resolveRelationships`, `DmErrorCode`, `searchUsers()` (client) are named identically across task 1 → task 8.
- **Path consistency:** `apps/web/src/components/dm/NewDmDialog.tsx` is used throughout (spec's `chat/` path was stale; this plan uses the real one).
- **Fixture consistency:** all Supertest sign-ups pass `TEST_PASSWORD_OK` from `apps/backend/tests/helpers/fixtures.ts` per feedback memory `feedback-signup-rate-limit-flush` + REQ-006 blocklist requirement.
- **Risk — e2e selector drift:** the Playwright spec reaches for labels on the friend-requests page (`/friends`) that weren't inspected during plan writing; if the label text differs, step 2 of task 9 flags a selector update, not a test loosening.
